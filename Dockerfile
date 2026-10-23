FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
# The image listens on 0.0.0.0, so it is for the API engine (ENGINE=agent-sdk refuses non-loopback hosts).
ENV NODE_ENV=production HOST=0.0.0.0 ENGINE=api
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public
USER node
EXPOSE 3000
# HOST=0.0.0.0 means the app refuses to start unless DASHBOARD_PASSWORD is set.
CMD ["node", "dist/start.js"]
