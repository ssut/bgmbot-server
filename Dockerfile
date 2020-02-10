FROM node:12-alpine as dep

WORKDIR /app

RUN apk add --no-cache git

ADD package.json .
ADD package-lock.json .
ADD tsconfig.json .
RUN NODE_ENV=development npm i -D
COPY . .
RUN npm run build
RUN npm prune --production

FROM jrottenberg/ffmpeg:4.1-alpine
WORKDIR /app
EXPOSE 3200
ENV ENCODER_USE_NORMALIZE=1
ENV ENCODER_FFMPEG_NORMALIZE=/usr/bin/ffmpeg-normalize

VOLUME ["/downloads"]

RUN apk add --no-cache --repository http://dl-cdn.alpinelinux.org/alpine/v3.11/main/ nodejs=12.15.0-r1 npm=12.15.0-r1 python3 py-pip bash
RUN pip --no-cache-dir install ffmpeg-normalize

COPY --from=dep /app/node_modules node_modules
COPY --from=dep /app/dist dist
ADD package.json .
ADD package-lock.json .
ADD entrypoint.sh .
RUN chmod +x entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
