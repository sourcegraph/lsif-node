FROM sourcegraph/src-cli:3.12@sha256:261b4c0a112ff43a1e752ce8d0aae0d95c15efc74245f76bb47761560c975619 AS src-cli

FROM node:13.14.0-alpine3.10@sha256:11a7f448074e918f0e120e7b82892a57368ec531ef2215d5595620fb328bba44

ARG TAG

RUN apk add --no-cache git

COPY --from=src-cli /usr/bin/src /usr/bin
RUN npm install -g @sourcegraph/lsif-tsc@${TAG}

ENTRYPOINT []
CMD ["/bin/sh"]
