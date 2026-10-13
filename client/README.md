# PulseOps dashboard

The React/Vite client provides Overview, Services, Incidents, Metrics, and
Experiments screens. The Overview and Services screens show probe health,
last-check time, actual HTTP response latency when measured, failure outcome,
and an explicit `Real HTTP probe` or `Unconfigured` label. Simulator health
and latency are shown separately and continue to power the local manual
failure/recovery controls.

The Metrics page requests only `source=http_probe` records from the API. It
provides service and time-range selectors, average/minimum/maximum measured
latency, sample count, and a chronological latency chart. Samples with null
latency (for example, a timeout) remain counted but are not plotted or
included in latency statistics. Its 500-record chart request limit is
separate from the summary, which covers all samples in the selected time
range.

The chart uses the existing Recharts dependency. The client obtains services,
incidents, metrics, and experiment history through the API and refreshes
relevant screens after Socket.IO events. REST responses remain authoritative;
Socket.IO is transient and reconnects automatically.

## Run the dashboard

```powershell
Set-Location C:\Users\Victus\pulseops\client
npm install
npm run dev
```

The default API origin is `http://localhost:5000`. Set `VITE_API_URL` to the
full API base URL (for example, `https://pulseops.example/api`) at build time
to point to another backend. The backend keeps health endpoint URLs
server-side; no probe credentials or endpoint configuration are embedded in
the client.

## Validate

```powershell
Set-Location C:\Users\Victus\pulseops\client
npm run lint
npm run build
```
