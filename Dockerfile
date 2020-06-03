FROM sourcegraph/src-cli:3.14@sha256:f5efa2468366ddafb4143e0d0f379a1c898d6e48b57b61ef2a9a3e60d093063a AS src-cli

FROM node:13.14.0-alpine3.10@sha256:11a7f448074e918f0e120e7b82892a57368ec531ef2215d5595620fb328bba44

ARG TAG

RUN apk add --no-cache git

COPY --from=src-cli /usr/bin/src /usr/bin
RUN npm install -g @sourcegraph/lsif-tsc@${TAG}

ENTRYPOINT []
CMD ["/bin/sh"]
