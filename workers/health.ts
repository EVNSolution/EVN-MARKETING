import { readWorkerHealth } from '@/lib/worker-health'

readWorkerHealth().then((result) => {
  console.log(JSON.stringify(result))
  process.exitCode = result.ok ? 0 : 1
})
