export const DEFAULT_SERVICES = [
  { id: "user-service", name: "User Service", latency: 45 },
  { id: "order-service", name: "Order Service", latency: 80 },
  { id: "payment-service", name: "Payment Service", latency: 100 }
];

export const NORMAL_LATENCY = Object.fromEntries(
  DEFAULT_SERVICES.map((service) => [service.id, service.latency])
);

export const SERVICE_ORDER = new Map(
  DEFAULT_SERVICES.map((service, index) => [service.id, index])
);
