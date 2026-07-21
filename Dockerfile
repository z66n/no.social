FROM denoland/deno:2.9.3 AS deps

WORKDIR /app

COPY deno.json deno.lock* ./
COPY server.ts ./

RUN deno cache --unstable-kv server.ts

FROM denoland/deno:2.9.3

WORKDIR /app

COPY --from=deps /root/.cache/deno /root/.cache/deno

COPY . .

ENV DENO_KV_PATH=/data/kv.sqlite3
RUN mkdir -p /data

EXPOSE 8000

CMD ["run", "-A", "--unstable-kv", "server.ts"]