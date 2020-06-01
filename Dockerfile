FROM sourcegraph/src-cli:3.12@sha256:29b4c48172e947adaedd0e005dff423b7d9ce592f1136f732db096f6a14bbd8c AS src-cli

FROM node:13.14.0-alpine3.10@sha256:11a7f448074e918f0e120e7b82892a57368ec531ef2215d5595620fb328bba44

ARG TAG

RUN apk add --no-cache git

COPY --from=src-cli /usr/bin/src /usr/bin
RUN npm install -g @sourcegraph/lsif-tsc@${TAG}

ENTRYPOINT []
CMD ["/bin/sh"]
