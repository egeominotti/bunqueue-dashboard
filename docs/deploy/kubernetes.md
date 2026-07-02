---
title: Kubernetes
description: Deploy the bunqueue dashboard to Kubernetes with a Deployment, Service, and Ingress. Copy-paste manifests, health probes, and TLS notes.
---

# Kubernetes

The dashboard is a stateless static container, so a plain **Deployment +
Service + Ingress** is all you need. It scales horizontally with zero shared
state.

## Manifests

Save as `dashboard.yaml` and `kubectl apply -f dashboard.yaml`.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: bunqueue-dashboard
  labels: { app: bunqueue-dashboard }
spec:
  replicas: 2
  selector:
    matchLabels: { app: bunqueue-dashboard }
  template:
    metadata:
      labels: { app: bunqueue-dashboard }
    spec:
      containers:
        - name: dashboard
          image: ghcr.io/egeominotti/bunqueue-dashboard:latest
          ports:
            - containerPort: 80
          readinessProbe:
            httpGet: { path: /, port: 80 }
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet: { path: /, port: 80 }
            initialDelaySeconds: 10
            periodSeconds: 20
          resources:
            requests: { cpu: 10m, memory: 32Mi }
            limits: { cpu: 250m, memory: 128Mi }
---
apiVersion: v1
kind: Service
metadata:
  name: bunqueue-dashboard
spec:
  selector: { app: bunqueue-dashboard }
  ports:
    - port: 80
      targetPort: 80
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: bunqueue-dashboard
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  tls:
    - hosts: [dashboard.example.com]
      secretName: bunqueue-dashboard-tls
  rules:
    - host: dashboard.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: bunqueue-dashboard
                port: { number: 80 }
```

The container's Caddy config already returns `index.html` for unknown paths, so
React Router deep links work behind the Ingress with no extra rewrite rules.

## Pointing at your bunqueue server

Two options, same as everywhere:

- **Direct:** build a custom image with
  `--build-arg VITE_BUNQUEUE_URL=https://queue.example.com` and use it in place
  of the published one. The bunqueue server needs CORS for the dashboard host.
- **Same-origin:** run bunqueue in the cluster and route `/api` to it. Either
  add a `reverse_proxy` to the container's Caddyfile via a **ConfigMap**
  mounted at `/etc/caddy/Caddyfile` (see [Docker](/deploy/docker#same-origin-api-proxy)),
  or add a second Ingress `path: /api` pointing at the bunqueue Service. No CORS
  needed.

## Health and scaling

- The `readinessProbe` keeps traffic off a pod until Caddy is serving; the
  `livenessProbe` restarts a wedged one.
- The image is tiny and stateless, so bump `replicas` freely or attach a
  `HorizontalPodAutoscaler`. There is no session affinity to worry about.

::: warning No control agent in the cluster
The container is the **static** build, so Server Control is not available. Do
not try to run the all-in-one server (with the control agent) in a shared
cluster: it is loopback-bound and meant to manage a bunqueue process on the
**same host**, not across pods.
:::
