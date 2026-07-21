FROM denoland/deno:2.9.3

WORKDIR /app

# 1. 明确指定 Deno 缓存目录，避免路径解析问题
ENV DENO_DIR=/deno-dir

# 2. 优先复制依赖清单和入口文件
# Docker 会缓存这一步。只要这些文件不变，后续的 cache 步骤就不会重新执行
COPY deno.json deno.lock* ./
COPY server.ts ./

# 3. 预缓存所有依赖
RUN deno cache --unstable-kv server.ts

# 4. 复制剩余的所有项目源代码
COPY . .

# 6. 配置 Deno KV 持久化路径，指向 Render 的 Persistent Disk
ENV DENO_KV_PATH=/data/kv.sqlite3
RUN mkdir -p /data

EXPOSE 8000

# 7. 启动命令
CMD ["run", "-A", "--unstable-kv", "server.ts"]