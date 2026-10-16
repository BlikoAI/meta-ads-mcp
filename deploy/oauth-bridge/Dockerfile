FROM node:22-alpine3.24

WORKDIR /app

COPY package.json oauth.mjs operator.mjs server.mjs ./

ENV NODE_ENV=production
ENV PORT=8080

RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080

CMD ["node", "server.mjs"]
