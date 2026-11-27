FROM node:20-alpine

WORKDIR /app

COPY order-service/package*.json ./
RUN npm install --omit=dev

COPY order-service/src ./src
COPY common ./common

EXPOSE 8001

CMD ["npm", "start"]
