FROM sourcegraph/src-cli:3.11 AS src-cli

FROM node:13.3.0-alpine3.10

ARG TAG

RUN apk add --no-cache git

COPY --from=src-cli /usr/bin/src /usr/bin
RUN npm install -g @sourcegraph/lsif-tsc@${TAG}

ENTRYPOINT []
CMD ["/bin/sh"]
