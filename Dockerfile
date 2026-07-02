# Stage 1: compile the GVGAI engine with JDK 11
FROM eclipse-temurin:11-jdk-jammy AS java-build
WORKDIR /build
COPY src ./src
COPY gson-2.6.2.jar ./
RUN find src -name '*.java' > sources.txt \
 && javac -encoding UTF-8 -cp gson-2.6.2.jar -d classes @sources.txt

# Stage 2: JRE 11 + Node 22 runtime
FROM eclipse-temurin:11-jre-jammy
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates fontconfig fonts-dejavu-core \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci --omit=dev

# Bake the hydrated engine runtime that game-manager.js expects at
# web/.gvgai-runtime, so the git-based prepare script never runs in the container.
COPY src ./web/.gvgai-runtime/source/src
COPY examples ./web/.gvgai-runtime/source/examples
COPY sprites ./web/.gvgai-runtime/source/sprites
COPY gson-2.6.2.jar ./web/.gvgai-runtime/source/gson-2.6.2.jar
COPY --from=java-build /build/classes ./web/.gvgai-runtime/classes
RUN printf '{"preparedBy":"Dockerfile"}\n' > ./web/.gvgai-runtime/runtime.json

COPY web ./web

# the Node layer reads VGDL defs + the game index from the project root
COPY examples ./examples

ENV NODE_ENV=production
WORKDIR /app/web
EXPOSE 3000
CMD ["node", "server.js"]
