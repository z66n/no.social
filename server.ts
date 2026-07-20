import { createFederation, exportJwk, generateCryptoKeyPair, importJwk } from "@fedify/fedify";
import { configure, getConsoleSink } from "@logtape/logtape";
import { Accept, Follow, Person, Image, Create, Note, Delete, Undo } from "@fedify/vocab";  
import { DenoKvStore } from "@fedify/denokv";
import { behindProxy } from "@hongminhee/x-forwarded-fetch";

const CONFIG = {
  username: Deno.env.get("AP_USERNAME")?.trim() || "me",
  displayName: Deno.env.get("AP_DISPLAY_NAME")?.trim() || "me",
  summary: Deno.env.get("AP_SUMMARY")?.trim() || "Powered by no.social - A minimal serverless ActivityPub publisher.",
  apiToken: Deno.env.get("AP_API_TOKEN")?.trim() || "",
  avatarUrl: Deno.env.get("AP_AVATAR_URL")?.trim() || "https://api.dicebear.com/9.x/identicon/png?seed=Tom&scale=80",
};

await configure({
  sinks: { console: getConsoleSink() },
  filters: {},
  loggers: [
    { category: "fedify",  sinks: ["console"], lowestLevel: "info" },
  ],
});

const kv = await Deno.openKv();  // Open the key–value store

async function saveNote(note: Note) {
  await kv.set(
    ["notes", note.id!.href],
    {
      id: note.id!.href,
      attribution: note.attributionId?.href,
      url: note.url instanceof URL ? note.url.href : note.url?.href,
      content: note.content,
      published: note.published?.toString(),
      to: note.toId?.href,
      cc: note.ccId?.href,
      deleted: false,
    },
  );
}

async function getNote(id: string | URL): Promise<Note | null> {
  const key = id instanceof URL ? id.href : id;
  const entry = await kv.get<{ id: string; attribution: string | null; url: string | null; content: string; published: string; to: string | null; cc: string | null; deleted: boolean }>(["notes", key]);
  if (!entry.value || entry.value.deleted) {
    return null;
  }
  return new Note({
    id: new URL(entry.value.id),
    attribution: entry.value.attribution ? new URL(entry.value.attribution) : undefined,
    url: entry.value.url ? new URL(entry.value.url) : undefined,
    content: entry.value.content,
    published: entry.value.published ? Temporal.Instant.from(entry.value.published) : undefined,
    to: entry.value.to ? new URL(entry.value.to) : undefined,
    cc: entry.value.cc ? new URL(entry.value.cc) : undefined,
  });
}

async function saveActivity(activity: Create, note: Note) {
  await kv.set(
    ["activities", activity.id!.href],
    {
      id: activity.id!.href,
      actor: activity.actorId!.href,
      object: note.id!.href,
    },
  );
}

const federation = createFederation({
  kv: new DenoKvStore(kv),
});

federation
  .setActorDispatcher("/users/{identifier}", async (ctx, identifier) => {
    if (identifier !== CONFIG.username) return null;
    const keyPairs = await ctx.getActorKeyPairs(identifier);
    return new Person({
      id: ctx.getActorUri(identifier),
      name: CONFIG.displayName,
      summary: CONFIG.summary,
      preferredUsername: CONFIG.username,
      url: new URL("/", ctx.url),
      inbox: ctx.getInboxUri(identifier),
      outbox: ctx.getOutboxUri(identifier),
      followers: ctx.getFollowersUri(identifier),
      // publicKey: keyPairs[0].cryptographicKey,
      publicKeys: keyPairs.map(k => k.cryptographicKey),
      // assertionMethods: keyPairs.map(k => k.multikey),
      icon: new Image({
        url: new URL(CONFIG.avatarUrl),
        mediaType: "image/png", // image/jpeg, image/png, image/gif, etc. depending on the actual image type
      }),
    });
  })
  .setKeyPairsDispatcher(async (ctx, identifier) => {
    if (identifier != CONFIG.username) return [];  // Other than "me" is not found.
    const entry = await kv.get<{
      privateKey: JsonWebKey;
      publicKey: JsonWebKey;
    }>(["key"]);
    if (entry == null || entry.value == null) {
      // Generate a new key pair at the first time:
      const { privateKey, publicKey } =
        await generateCryptoKeyPair("RSASSA-PKCS1-v1_5");
      // Store the generated key pair to the Deno KV database in JWK format:
      await kv.set(
        ["key"],
        {
          privateKey: await exportJwk(privateKey),
          publicKey: await exportJwk(publicKey),
        }
      );
      return [{ privateKey, publicKey }];
    }
    // Load the key pair from the Deno KV database:
    const privateKey = await importJwk(entry.value.privateKey, "private");
    const publicKey =  await importJwk(entry.value.publicKey, "public");
    return [{ privateKey, publicKey }];
  });

federation
  .setInboxListeners("/users/{identifier}/inbox", "/inbox")
  .on(Follow, async (ctx, follow) => {
    if (follow.id == null || follow.actorId == null || follow.objectId == null) {
      return;
    }
    const parsed = ctx.parseUri(follow.objectId);
    if (parsed?.type !== "actor" || parsed.identifier !== CONFIG.username) return;
    const follower = await follow.getActor(ctx);
    if (follower == null) return;
    // Note that if a server receives a `Follow` activity, it should reply
    // with either an `Accept` or a `Reject` activity.  In this case, the
    // server automatically accepts the follow request:
    await ctx.sendActivity(
      { identifier: parsed.identifier },
      follower,
      new Accept({ actor: follow.objectId, object: follow }),
    );
    // Store the follower in the key–value store:
    await kv.set(["followers", follow.actorId.href], {
      id: follow.actorId.href,
      inboxId: follower.inboxId?.href,
      username: follower.preferredUsername,
      url: follower.url?.href,
    });
  })
  .on(Undo, async (ctx, undo) => {
    if (undo.id == null || undo.actorId == null) return;
    const object = await undo.getObject(ctx);
    if (!(object instanceof Follow)) return;
    const follow = object as Follow;
    if (follow.objectId == null) return;
    const parsed = ctx.parseUri(follow.objectId);
    if (parsed?.type !== "actor" || parsed.identifier !== CONFIG.username) return;
    await kv.delete(["followers", undo.actorId.href]);
    console.log(`[Unfollow] Removed follower: ${undo.actorId.href}`);
  });

federation.setOutboxDispatcher(
  "/users/{identifier}/outbox",
  async (ctx, identifier) => {
    if (identifier !== CONFIG.username) return null;
    const items: Create[] = [];
    for await (const entry of kv.list<{ id: string; actor: string; object: string }>({
      prefix: ["activities"],
    })) {
      const value = entry.value;
      const note = await getNote(value.object);
      if (note == null) continue;
      items.push(
        new Create({
          id: new URL(value.id),
          actor: new URL(value.actor),
          object: note,
        }),
      );
    }
    return {
      items,
    };
  },
);

federation.setFollowersDispatcher(
  "/users/{identifier}/followers",
  async (ctx, identifier, cursor) => {
    if (identifier !== CONFIG.username) return null;
    const followers: { id: URL; inboxId: URL | null; username: string; url: URL | null }[] = [];
    for await (const entry of kv.list<{ id: string; inboxId: string; url: string; username: string }>({
      prefix: ["followers"],
    })) {
      const value = entry.value;
      followers.push({
        id: new URL(value.id),
        inboxId: value.inboxId ? new URL(value.inboxId) : null,
        username: value.username,
        url: value.url ? new URL(value.url) : null,
      });
    }
    return {
      items: followers,
    };
  },
);

federation.setObjectDispatcher(
  Note,
  "/notes/{id}",
  async (ctx) => {
    return await getNote(ctx.url.href);
  },
);

Deno.serve(
  behindProxy(async (request) => {
    const ctx = federation.createContext(request, undefined);
    const followersUri = ctx.getFollowersUri(CONFIG.username);
    const actorUri = ctx.getActorUri(CONFIG.username);
    const url = new URL(request.url);

    // Home page:
    if (url.pathname === "/") {
      const followers: { id: string; username: string | null; url: string | null; }[] = [];
      for await (const entry of kv.list<{ id: string; username: string | null; url: string | null; }>({ prefix: ["followers"] })) {
        const val = entry.value;
        if (typeof val === "string") {
          followers.push({ id: val, username: null, url: val });
        } else if (val && typeof val === "object") {
          if (!followers.some(f => f.id === val.id)) {
            followers.push({ id: val.id, username: val.username || null, url: val.url || null });
          }
        }
      }

      const notes: { id: string; content: string; published: string }[] = [];
      for await (const entry of kv.list<{ id: string; content: string; published: string; deleted?: boolean }>({ prefix: ["notes"] })) {
        if (entry.value.deleted) continue; 
        notes.push(entry.value);
      }
      notes.sort((a, b) => new Date(b.published).getTime() - new Date(a.published).getTime());

      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>no.social</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
              body { font-family: system-ui, sans-serif; max-width: 600px; margin: 2rem auto; padding: 0 1rem; }
              .note { border-bottom: 1px solid #eee; padding: 1rem 0; }
              .note-meta { font-size: 0.8rem; color: #666; margin-bottom: 0.5rem; }
              button { cursor: pointer; padding: 0.5rem 1rem; }
              .admin-btn { background: #f0f0f0; border: 1px solid #ccc; font-size: 0.8rem; margin-left: 0.5rem; }
              .admin-btn:hover { background: #e0e0e0; }
              .delete-btn { color: red; border-color: red; background: white; }
              .handle-box {
                background: #f9f9f9;
                padding: 1.25rem;
                border-radius: 12px;
                margin: 1.5rem 0;
                border: 1px dashed #ccc;
                display: flex;
                align-items: center;
                gap: 1rem;
                text-align: left;
              }
              .handle-box .avatar {
                width: 72px;
                height: 72px;
                border-radius: 50%;
                object-fit: cover;
                flex-shrink: 0;
                background: #e0e0e0;
              }
              .handle-box .actor-info { flex: 1; min-width: 0; }
              .handle-box .display-name { font-size: 1.15rem; font-weight: 700; color: #222; margin: 0 0 0.15rem 0; line-height: 1.2; }
              .handle-box .actor-handle { font-size: 0.9rem; color: #666; margin: 0 0 0.6rem 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
              .handle-box .actor-summary { font-size: 0.9rem; color: #444; line-height: 1.45; margin: 0 0 0.75rem 0; }
              .follow-btn {
                background: #6364ff; color: white; border: none; padding: 0.6rem 1.2rem;
                border-radius: 6px; font-weight: 600; font-size: 0.95rem; cursor: pointer; transition: background 0.2s;
              }
              .follow-btn:hover { background: #5657e6; }
              .modal {
                display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(0,0,0,0.5); align-items: center; justify-content: center; z-index: 1000;
              }
              .modal-content {
                background: white; padding: 2rem; border-radius: 12px; max-width: 400px; width: 90%;
                box-shadow: 0 4px 20px rgba(0,0,0,0.15);
              }
              .modal-content h3 { margin: 0 0 1rem 0; font-size: 1.2rem; }
              .modal-content p { margin: 0 0 1rem 0; color: #666; font-size: 0.9rem; }
              .modal-content input {
                width: 100%; padding: 0.6rem; border: 1px solid #ddd; border-radius: 6px;
                font-size: 1rem; margin-bottom: 1rem; box-sizing: border-box;
              }
              .modal-content input:focus { outline: none; border-color: #6364ff; }
              .modal-buttons { display: flex; gap: 0.5rem; justify-content: flex-end; }
              .modal-buttons button { padding: 0.5rem 1rem; border-radius: 6px; font-size: 0.9rem; cursor: pointer; }
              .modal-cancel { background: #f0f0f0; border: 1px solid #ddd; }
              .modal-confirm { background: #6364ff; color: white; border: none; }
              @media (max-width: 420px) {
                .handle-box { flex-direction: column; align-items: center; text-align: center; }
              }
            </style>
          </head>
          <body>
            <h1>no.social</h1>
            <p><i>A minimal serverless ActivityPub publisher.</i></p>

            <div class="handle-box">
              <img class="avatar"
                  src="${CONFIG.avatarUrl}"
                  alt="${CONFIG.displayName}"
                  onerror="this.style.display='none'" />
              <div class="actor-info">
                <p class="display-name">${CONFIG.displayName}</p>
                <p class="actor-handle">@${CONFIG.username}@${url.hostname}</p>
                <p class="actor-summary">${CONFIG.summary}</p>
                <button class="follow-btn" onclick="openFollowModal()">Follow</button>
              </div>
            </div>

            <div id="followModal" class="modal">
              <div class="modal-content">
                <h3>Follow on Mastodon</h3>
                <p>Enter your instance address to follow:</p>
                <input type="text" id="instanceInput" placeholder="mastodon.social" />
                <div class="modal-buttons">
                  <button class="modal-cancel" onclick="closeFollowModal()">Cancel</button>
                  <button class="modal-confirm" onclick="followFromModal()">Continue</button>
                </div>
              </div>
            </div>
            
            <h2>Followers (${followers.length})</h2>
            <ul>
              ${followers.map((f) => {
                const displayText = f.username || f.url || f.id;
                const link = f.url || f.id;
                return `<li><a href="${link}" target="_blank" rel="noopener noreferrer">${displayText}</a></li>`;
              }).join("")}
            </ul>

            <hr>
            
            <button onclick="promptPost()">+ Post New Note</button>
            
            <h2>Recent Notes</h2>
            ${notes.length === 0 ? '<p>No notes yet.</p>' : ''}
            ${notes.map((note) => `
              <div class="note">
                <div class="note-meta">
                  ${new Date(note.published).toLocaleString()}
                  <button class="admin-btn delete-btn" onclick="promptDelete('${note.id}')">Delete</button>
                </div>
                <div>${note.content}</div>
              </div>
            `).join("")}

            <script>
              const ACTOR_URL = "https://${url.hostname}/users/${CONFIG.username}";

              async function promptPost() {
                const token = prompt("Enter AP_API_TOKEN to post:");
                if (!token) return;
                const content = prompt("Enter note content:");
                if (!content) return;

                const res = await fetch('/notes', {
                  method: 'POST',
                  headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token 
                  },
                  body: JSON.stringify({ content })
                });
                
                if (res.ok) {
                  alert("Posted successfully!");
                  location.reload();
                } else {
                  alert("Failed: " + res.statusText);
                }
              }

              async function promptDelete(noteId) {
                const token = prompt("Enter AP_API_TOKEN to delete:");
                if (!token) return;
                if (!confirm("Are you sure you want to delete this note? This will broadcast a Delete activity.")) return;

                const pathname = new URL(noteId).pathname;

                const res = await fetch(pathname, {
                  method: 'DELETE',
                  headers: { 'Authorization': 'Bearer ' + token }
                });

                if (res.ok) {
                  alert("Deleted successfully!");
                  location.reload();
                } else {
                  alert("Failed: " + res.statusText);
                }
              }

              function openFollowModal() {
                document.getElementById('followModal').style.display = 'flex';
                document.getElementById('instanceInput').focus();
              }

              function closeFollowModal() {
                document.getElementById('followModal').style.display = 'none';
                document.getElementById('instanceInput').value = '';
              }

              function followFromModal() {
                let instance = document.getElementById('instanceInput').value.trim();
                if (!instance) return;
                
                instance = instance.replace(/^https?:\\/\\//, '').replace(/\\/$/, '');
                
                window.open(\`https://\${instance}/authorize_interaction?uri=\${encodeURIComponent(ACTOR_URL)}\`, '_blank');
                closeFollowModal();
              }

              document.getElementById('instanceInput').addEventListener('keypress', function(e) {
                if (e.key === 'Enter') {
                  followFromModal();
                }
              });

              document.getElementById('followModal').addEventListener('click', function(e) {
                if (e.target === this) {
                  closeFollowModal();
                }
              });
            </script>
          </body>
        </html>
      `;

      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/clear-kv") {
      for await (const entry of kv.list({ prefix: ["activities"] })) {
        await kv.delete(entry.key);
      }

      for await (const entry of kv.list({ prefix: ["notes"] })) {
        await kv.delete(entry.key);
      }

      for await (const entry of kv.list({ prefix: ["followers"] })) {
        await kv.delete(entry.key);
      }

      return new Response("cleared");
    }

    if (url.pathname.startsWith("/notes/") && request.method === "GET") {
      const entry = await kv.get<{ deleted?: boolean }>(["notes", url.href]);
      if (entry.value?.deleted) {
        return new Response("Gone", { status: 410 });
      }
    }

    if (url.pathname === "/notes" && request.method === "POST") {
      if (!CONFIG.apiToken || request.headers.get("Authorization") !== `Bearer ${CONFIG.apiToken}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      const contentType = request.headers.get("content-type") || "";
      let content = "";

      if (contentType.includes("application/json")) {
        const body = await request.json();
        content = body.content;
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        const formData = await request.formData();
        content = formData.get("content")?.toString() || "";
      }

      if (!content) return new Response("Missing content", { status: 400 });

      const noteId = new URL(
        `/notes/${crypto.randomUUID()}`,
        url,
      );

      const activityId = new URL(
        `/activities/${crypto.randomUUID()}`,
        url,
      );

      const note = new Note({
        id: noteId,
        attribution: actorUri,
        url: noteId,
        content,
        published: Temporal.Now.instant(),
        to: new URL("https://www.w3.org/ns/activitystreams#Public"),
        cc: followersUri,
      });

      await saveNote(note);

      const activity = new Create({
        id: new URL(
          `/activities/${crypto.randomUUID()}`,
          url,
        ),
        actor: actorUri,
        object: note,
      });

      await saveActivity(activity, note);

      await ctx.sendActivity(
        { identifier: CONFIG.username },
        "followers",
        activity,
      );

      if (contentType.includes("application/x-www-form-urlencoded")) {
        return Response.redirect(new URL("/", url), 303);
      }

      return Response.json({
        id: activityId.href,
        status: "created",
      });
    }

    if (url.pathname.startsWith("/notes/") && request.method === "DELETE") {
      if (!CONFIG.apiToken || request.headers.get("Authorization") !== `Bearer ${CONFIG.apiToken}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      const noteId = new URL(url.pathname, url).href;
      const note = await getNote(noteId);
      
      if (!note) return new Response("Not found", { status: 404 });

      const deleteActivity = new Delete({
        id: new URL(`/activities/delete/${crypto.randomUUID()}`, url),
        actor: ctx.getActorUri(CONFIG.username),
        object: note.id,
      });

      await ctx.sendActivity({ identifier: CONFIG.username }, "followers", deleteActivity);

      await kv.set(["notes", noteId], {
        ...note,
        deleted: true, 
      });
      
      return new Response("Deleted", { status: 200 });
    }

    // Federation-related requests:
    return await federation.fetch(request, {
      contextData: undefined,
    });
  }),
);