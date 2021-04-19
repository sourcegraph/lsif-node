FROM sourcegraph/src-cli:3.27.0@sha256:04b336e7bce104a13a497b539c4e5858a4ef636d7fc1cda88529863379595d75 AS src-cli

FROM node:14.5-alpine3.10@sha256:7fb1e608dc4081c25930db83cb4a5df884b6a3f6e4e9f5fa2df08f22778fcfad

ARG TAG

RUN apk add --no-cache git

COPY --from=src-cli /usr/bin/src /usr/bin

RUN npm install -g @sourcegraph/lsif-tsc@${TAG}

CMD ["/bin/sh"]
