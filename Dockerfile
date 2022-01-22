FROM sourcegraph/src-cli:3.36.1@sha256:5a59042c4f730b7e6ae7f82b4d20fd0d3cc64e190a9cae8c66ea9d44b32cb309 AS src-cli

FROM node:14.5-alpine3.10@sha256:7fb1e608dc4081c25930db83cb4a5df884b6a3f6e4e9f5fa2df08f22778fcfad

ARG TAG

RUN apk add --no-cache git

COPY --from=src-cli /usr/bin/src /usr/bin

RUN npm install -g @sourcegraph/lsif-tsc@${TAG}

CMD ["/bin/sh"]
