import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  INIT_SCRIPT,
  readMetrics,
  readTransfer,
  resetMetrics,
} from "./metrics.mjs";

function fixture(
  supported = [
    "longtask",
    "event",
    "layout-shift",
    "paint",
    "largest-contentful-paint",
  ],
) {
  const records = new Map();
  const entries = { resource: [], navigation: [] };
  class Observer {
    static supportedEntryTypes = supported;
    constructor(callback) {
      this.callback = callback;
    }
    observe({ type }) {
      if (!supported.includes(type)) throw new Error("unsupported");
      this.type = type;
      records.set(type, []);
    }
    takeRecords() {
      return records.get(this.type).splice(0);
    }
  }
  const context = vm.createContext({
    PerformanceObserver: Observer,
    URL,
    performance: {
      now: () => 1000,
      getEntriesByType: (type) => entries[type] ?? [],
    },
  });
  vm.runInContext(INIT_SCRIPT, context);
  const page = {
    evaluate: (fn) => vm.runInContext(`(${fn.toString()})()`, context),
  };
  return { page, records, entries };
}

test("unsupported measurements and absent qualifying events remain missing", async () => {
  const { page } = fixture([]);
  const metrics = await readMetrics(page);
  for (
    const key of [
      "longTaskMax",
      "blockingTime",
      "maxEventDuration",
      "eventCount",
      "cls",
      "lcp",
    ]
  ) {
    assert.equal(metrics[key], null, key);
  }
});

test("supported idle windows report zero tasks but no invented event latency", async () => {
  const { page } = fixture();
  const metrics = await readMetrics(page);
  assert.equal(metrics.longTaskMax, 0);
  assert.equal(metrics.blockingTime, 0);
  assert.equal(metrics.maxEventDuration, null);
});

test("pending records are flushed and reset isolates the interaction window", async () => {
  const { page, records } = fixture();
  records.get("longtask").push({ startTime: 10, duration: 250 });
  assert.equal((await readMetrics(page)).blockingTime, 200);
  await resetMetrics(page);
  records.get("longtask").push({ startTime: 999, duration: 100 }, {
    startTime: 1001,
    duration: 75,
  });
  records.get("event").push({
    name: "click",
    startTime: 1002,
    duration: 64,
    processingStart: 1005,
    processingEnd: 1010,
  });
  records.get("layout-shift").push({ startTime: 998, value: 0.9 }, {
    startTime: 1003,
    value: 0.01,
  });
  const metrics = await readMetrics(page);
  assert.equal(metrics.blockingTime, 25);
  assert.equal(metrics.longTaskCount, 1);
  assert.equal(metrics.maxEventDuration, 64);
  assert.equal(metrics.eventDelayMax, 3);
  assert.equal(metrics.eventProcessingMax, 5);
  assert.equal(metrics.cls, 0.01);
  assert.equal(metrics.observationStart, 1000);
});

test("query strings and hashed font paths keep the correct resource type", async () => {
  const { page, entries } = fixture();
  entries.resource = [
    { name: "https://app.test/assets/app.css?v=1", transferSize: 500 },
    { name: "https://app.test/assets/app.js?v=1", transferSize: 600 },
    {
      name: "https://app.test/assets/Barlow-hash.woff2",
      transferSize: 0,
      encodedBodySize: 9632,
    },
  ];
  entries.navigation = [{ transferSize: 700 }];
  const transfer = await readTransfer(page);
  assert.equal(transfer.total, 1800);
  assert.equal(transfer.byType.css, 500);
  assert.equal(transfer.byType.js, 600);
  assert.equal(transfer.byType.font, 0);
  assert.equal(transfer.resources[2].encodedBodySize, 9632);
});
