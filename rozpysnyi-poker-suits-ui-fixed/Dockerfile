FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV DISABLE_LOCAL_HTTPS=1

EXPOSE 3000

CMD ["npm", "start"]
