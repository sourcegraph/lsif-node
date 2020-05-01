FROM sourcegraph/src-cli:3.11@sha256:dfb2015e20f2b5a9203d437a6a767e90b64dda88f74a45f3d95116a39dbedfac AS src-cli

FROM node:13.13.0-alpine3.10@sha256:eae3fa3129539ac36082fdce28d15876735e1c5471de11fd4e198d37a3bc7109

ARG TAG

RUN apk add --no-cache git

COPY --from=src-cli /usr/bin/src /usr/bin
RUN npm install -g @sourcegraph/lsif-tsc@${TAG}

ENTRYPOINT []
CMD ["/bin/sh"]
