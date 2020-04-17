FROM node:13.3.0-alpine3.10

ARG TAG

RUN apk add --no-cache git

RUN npm install -g @sourcegraph/lsif-tsc@${TAG}

ENTRYPOINT ["lsif-tsc"]
