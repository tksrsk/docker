FROM alpine

RUN apk add --no-cache dnsmasq

ENTRYPOINT ["dnsmasq", "--keep-in-foreground", "--log-facility=-"]
