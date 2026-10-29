FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY bin/ ./bin/
COPY lib/ ./lib/
COPY mcp-server.js index.d.ts ./

RUN npm install --omit=dev --ignore-scripts

ENTRYPOINT ["node", "mcp-server.js"]
