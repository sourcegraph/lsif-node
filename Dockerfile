FROM sourcegraph/src-cli:3.15@sha256:3c36b8dafd7fc2172eedd9cca299e46f95e6d523d125767a20f0029432e3cd30 AS src-cli

FROM node:13.14.0-alpine3.10@sha256:11a7f448074e918f0e120e7b82892a57368ec531ef2215d5595620fb328bba44

ARG TAG

RUN apk add --no-cache git

COPY --from=src-cli /usr/bin/src /usr/bin
RUN npm install -g @sourcegraph/lsif-tsc@${TAG}

ENTRYPOINT []
CMD ["/bin/sh"]
