# app-tour — Demo Studio demoing itself

This project records Demo Studio's own UI (served by vite with the sample
data bridge) using Demo Studio's own pipeline. To reproduce:

```bash
npm run renderer          # serves the UI at http://localhost:5183
# then open this folder in Demo Studio and press Run — or headless:
node runner/runner.js --job=<(echo '{"kind":"run-auto","projectDir":"'$PWD'/demos/app-tour","demoSuitePath":"'$PWD'/vendor/demo-suite","userDataDir":"/tmp/ds-tour"}')
```

The `demo.json` here is also a worked example of the shot grammar: an
opening wide + hold, say → spot → waitForVo → spotOut cycles, `click` shots
driving real navigation, and a closing `cta` with its own narration line.
