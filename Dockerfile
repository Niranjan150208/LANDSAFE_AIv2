FROM node:22-alpine
WORKDIR /app
COPY . .
ENV PORT=3000 DB_PATH=/data/landsafe.db
VOLUME /data
EXPOSE 3000
CMD ["node", "--no-warnings", "server.js"]
