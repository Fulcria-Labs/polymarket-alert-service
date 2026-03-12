import { describe, test, expect, beforeEach } from 'bun:test';
import app from '../api';

// Helper to make requests to the Hono app
async function request(method: string, path: string, body?: any) {
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  return app.request(path, options);
}

describe('Portfolio API', () => {
  test('POST /portfolios creates a portfolio', async () => {
    const res = await request('POST', '/portfolios', {
      id: 'test-p1',
      name: 'Test Portfolio',
      markets: [
        { marketId: 'm1', label: 'Market A', outcome: 'Yes', weight: 0.5 },
        { marketId: 'm2', label: 'Market B', outcome: 'Yes', weight: 0.5 },
      ],
    });

    expect(res.status).toBe(201);
    const data = await res.json() as any;
    expect(data.success).toBe(true);
    expect(data.portfolio.id).toBe('test-p1');
    expect(data.portfolio.markets).toHaveLength(2);
  });

  test('POST /portfolios rejects invalid weights', async () => {
    const res = await request('POST', '/portfolios', {
      id: 'bad-p',
      name: 'Bad',
      markets: [
        { marketId: 'm1', label: 'A', outcome: 'Yes', weight: 0.3 },
      ],
    });

    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toContain('weights');
  });

  test('POST /portfolios rejects empty markets', async () => {
    const res = await request('POST', '/portfolios', {
      id: 'empty-p',
      name: 'Empty',
      markets: [],
    });

    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toContain('at least one market');
  });

  test('POST /portfolios rejects missing fields', async () => {
    const res = await request('POST', '/portfolios', {});
    expect(res.status).toBe(400);
  });

  test('GET /portfolios lists portfolios', async () => {
    // Create one first
    await request('POST', '/portfolios', {
      id: 'list-test',
      name: 'List Test',
      markets: [
        { marketId: 'mx', label: 'X', outcome: 'Yes', weight: 1.0 },
      ],
    });

    const res = await request('GET', '/portfolios');
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.count).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(data.portfolios)).toBe(true);
  });

  test('GET /portfolios/:id returns portfolio with performance', async () => {
    await request('POST', '/portfolios', {
      id: 'perf-test',
      name: 'Performance Test',
      markets: [
        { marketId: 'mp1', label: 'P1', outcome: 'Yes', weight: 1.0 },
      ],
    });

    const res = await request('GET', '/portfolios/perf-test');
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.portfolio.id).toBe('perf-test');
    expect(data.performance).toBeDefined();
    expect(data.performance.portfolioId).toBe('perf-test');
  });

  test('GET /portfolios/:id returns 404 for unknown', async () => {
    const res = await request('GET', '/portfolios/nonexistent');
    expect(res.status).toBe(404);
  });

  test('DELETE /portfolios/:id removes portfolio', async () => {
    await request('POST', '/portfolios', {
      id: 'del-test',
      name: 'Delete Me',
      markets: [
        { marketId: 'md', label: 'D', outcome: 'Yes', weight: 1.0 },
      ],
    });

    const delRes = await request('DELETE', '/portfolios/del-test');
    expect(delRes.status).toBe(200);

    const getRes = await request('GET', '/portfolios/del-test');
    expect(getRes.status).toBe(404);
  });

  test('DELETE /portfolios/:id returns 404 for unknown', async () => {
    const res = await request('DELETE', '/portfolios/ghost');
    expect(res.status).toBe(404);
  });
});

describe('Correlation API', () => {
  test('GET /correlation requires at least 2 markets', async () => {
    const res = await request('GET', '/correlation?markets=m1');
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toContain('at least 2');
  });

  test('GET /correlation returns matrix structure', async () => {
    const res = await request('GET', '/correlation?markets=m1,m2');
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.markets).toEqual(['m1', 'm2']);
    expect(data.matrix).toHaveLength(2);
    expect(data.matrix[0]).toHaveLength(2);
    expect(Array.isArray(data.pairs)).toBe(true);
  });

  test('GET /correlation supports outcome parameter', async () => {
    const res = await request('GET', '/correlation?markets=m1,m2&outcome=No');
    expect(res.status).toBe(200);
  });

  test('GET /correlation handles 3 markets', async () => {
    const res = await request('GET', '/correlation?markets=m1,m2,m3');
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.matrix).toHaveLength(3);
    expect(data.matrix[0]).toHaveLength(3);
    // 3 pairs: (m1,m2), (m1,m3), (m2,m3)
    expect(data.pairs).toHaveLength(3);
  });
});

describe('Divergence API', () => {
  test('GET /divergences requires at least 2 markets', async () => {
    const res = await request('GET', '/divergences?markets=m1');
    expect(res.status).toBe(400);
  });

  test('GET /divergences returns structure', async () => {
    const res = await request('GET', '/divergences?markets=m1,m2');
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.marketCount).toBe(2);
    expect(data.divergenceThreshold).toBe(10);
    expect(Array.isArray(data.divergences)).toBe(true);
  });

  test('GET /divergences supports custom threshold', async () => {
    const res = await request('GET', '/divergences?markets=m1,m2&threshold=5');
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.divergenceThreshold).toBe(5);
  });
});

describe('Arbitrage Scan API', () => {
  test('POST /arbitrage/scan detects opportunities', async () => {
    const res = await request('POST', '/arbitrage/scan', {
      markets: [
        {
          id: 'arb1',
          question: 'Overpriced market',
          outcomes: [
            { name: 'Yes', price: 70 },
            { name: 'No', price: 50 },
          ],
        },
        {
          id: 'arb2',
          question: 'Fair market',
          outcomes: [
            { name: 'Yes', price: 60 },
            { name: 'No', price: 40 },
          ],
        },
      ],
    });

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.scannedCount).toBe(2);
    expect(data.opportunities.length).toBeGreaterThanOrEqual(1);
    expect(data.opportunities[0].marketId).toBe('arb1');
  });

  test('POST /arbitrage/scan returns empty for fair markets', async () => {
    const res = await request('POST', '/arbitrage/scan', {
      markets: [
        {
          id: 'fair1',
          question: 'Fair',
          outcomes: [
            { name: 'Yes', price: 50 },
            { name: 'No', price: 50 },
          ],
        },
      ],
    });

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.opportunities).toHaveLength(0);
  });

  test('POST /arbitrage/scan rejects invalid body', async () => {
    const res = await request('POST', '/arbitrage/scan', {});
    expect(res.status).toBe(400);
  });

  test('POST /arbitrage/scan supports custom threshold', async () => {
    const res = await request('POST', '/arbitrage/scan', {
      threshold: 10,
      markets: [
        {
          id: 's1',
          question: 'Small gap',
          outcomes: [
            { name: 'Yes', price: 53 },
            { name: 'No', price: 50 },
          ],
        },
      ],
    });

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.opportunities).toHaveLength(0); // 3% < 10% threshold
  });

  test('POST /arbitrage/scan handles multi-outcome markets', async () => {
    const res = await request('POST', '/arbitrage/scan', {
      markets: [
        {
          id: 'multi',
          question: 'Who wins?',
          outcomes: [
            { name: 'A', price: 30 },
            { name: 'B', price: 30 },
            { name: 'C', price: 30 },
            { name: 'D', price: 30 },
          ],
        },
      ],
    });

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.opportunities).toHaveLength(1);
    expect(data.opportunities[0].totalPrice).toBe(120);
  });

  test('POST /arbitrage/scan handles empty market list', async () => {
    const res = await request('POST', '/arbitrage/scan', { markets: [] });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.scannedCount).toBe(0);
    expect(data.opportunities).toHaveLength(0);
  });
});
