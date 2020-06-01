FROM sourcegraph/src-cli:3.12@sha256:261b4c0a112ff43a1e752ce8d0aae0d95c15efc74245f76bb47761560c975619 AS src-cli

FROM node:13.13.0-alpine3.10@sha256:eae3fa3129539ac36082fdce28d15876735e1c5471de11fd4e198d37a3bc7109

ARG TAG

RUN apk add --no-cache git

COPY --from=src-cli /usr/bin/src /usr/bin
RUN npm install -g @sourcegraph/lsif-tsc@${TAG}

ENTRYPOINT []
CMD ["/bin/sh"]
