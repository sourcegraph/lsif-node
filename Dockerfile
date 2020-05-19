FROM sourcegraph/src-cli:3.12@sha256:29b4c48172e947adaedd0e005dff423b7d9ce592f1136f732db096f6a14bbd8c AS src-cli

FROM node:13.13.0-alpine3.10@sha256:eae3fa3129539ac36082fdce28d15876735e1c5471de11fd4e198d37a3bc7109

ARG TAG

RUN apk add --no-cache git

COPY --from=src-cli /usr/bin/src /usr/bin
RUN npm install -g @sourcegraph/lsif-tsc@${TAG}

ENTRYPOINT []
CMD ["/bin/sh"]
