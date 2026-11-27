FROM node:20-alpine

WORKDIR /app

COPY user-service/package*.json ./
RUN npm install --omit=dev

COPY user-service/src ./src
COPY common ./common

EXPOSE 8003

CMD ["npm", "start"]
