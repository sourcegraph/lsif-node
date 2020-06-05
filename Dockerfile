FROM sourcegraph/src-cli:3.15@sha256:641d86ae957d4f8ff441b6d89e43bafcdb864dd94858996fa042a13fc41e16b7 AS src-cli

FROM node:13.14.0-alpine3.10@sha256:11a7f448074e918f0e120e7b82892a57368ec531ef2215d5595620fb328bba44

ARG TAG

RUN apk add --no-cache git

COPY --from=src-cli /usr/bin/src /usr/bin
RUN npm install -g @sourcegraph/lsif-tsc@${TAG}

ENTRYPOINT []
CMD ["/bin/sh"]
