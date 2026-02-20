# ---------- Build client ----------
FROM node:18-alpine AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json* ./
RUN npm install
COPY client ./
RUN npm run build

# ---------- Build server ----------
FROM node:18-alpine AS server-build
WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm install --production
COPY server ./

# ---------- Runtime image ----------
FROM node:18-alpine
WORKDIR /app
ENV NODE_ENV=production
# copy server
COPY --from=server-build /app/server ./server
# copy built client into server public dir expectation
COPY --from=client-build /app/client/dist ./client/dist
WORKDIR /app/server
EXPOSE 8080
CMD ["node","server.js"]
