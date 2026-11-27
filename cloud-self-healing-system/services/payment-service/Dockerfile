FROM node:20-alpine

WORKDIR /app

COPY payment-service/package*.json ./
RUN npm install --omit=dev

COPY payment-service/src ./src
COPY common ./common

EXPOSE 8002

CMD ["npm", "start"]
