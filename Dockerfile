FROM sourcegraph/src-cli:3.36.2@sha256:4088bd83dc70d8f3441fedfef0b8d68b761916cf1df0ef0f5eb62c0009c67fea AS src-cli

FROM node:14.5-alpine3.10@sha256:7fb1e608dc4081c25930db83cb4a5df884b6a3f6e4e9f5fa2df08f22778fcfad

ARG TAG

RUN apk add --no-cache git

COPY --from=src-cli /usr/bin/src /usr/bin

RUN npm install -g @sourcegraph/lsif-tsc@${TAG}

CMD ["/bin/sh"]
