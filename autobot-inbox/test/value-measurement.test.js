import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

/**
 * Tests for the Value Measurement Script (immutable component).
 *
 * Uses PGlite (no DATABASE_URL) so tests are self-contained.
 * Tests verify:
 * - measureProductValue computes derived metrics correctly
 * - computeValueAssessment produces correct recommendations per threshold
 * - computeCohortRetention tracks cohort data
 * - getValueDashboard returns portfolio view
 * - checkLaw1Compliance identifies compliant and non-compliant products
 * - getProductHealth returns full product health summary
 * - Graceful handling when schema does not exist
 */

describe('value-measurement', () => {
  let measureProductValue, computeValueAssessment, computeCohortRetention;
  let getValueDashboard, checkLaw1Compliance, getProductHealth;
  let query;

  before(async () => {
    ({ query } = await getDb());

    const mod = await import('../src/value/value-measurement.js');
    measureProductValue = mod.measureProductValue;
    computeValueAssessment = mod.computeValueAssessment;
    computeCohortRetention = mod.computeCohortRetention;
    getValueDashboard = mod.getValueDashboard;
    checkLaw1Compliance = mod.checkLaw1Compliance;
    getProductHealth = mod.getProductHealth;

    // Seed test products (FK constraint requires products to exist)
    const testProducts = [
      'test-product-vr', 'test-product-ret',
      'test-product-assess-high', 'test-product-assess-mod',
      'test-product-assess-neg', 'test-product-assess-bad',
      'cohort-test-prod', 'nonexistent-product',
    ];
    for (const id of testProducts) {
      await query(
        `INSERT INTO autobot_value.products (id, name, status) VALUES ($1, $1, 'active') ON CONFLICT (id) DO NOTHING`,
        [id]
      );
    }
  });

  // NOTE: Do not call close() — PGlite cannot reinitialize after close

  it('measureProductValue returns null for empty product', async () => {
    const result = await measureProductValue('nonexistent-product', '2026-01-15');
    // Should still insert a zero-value row (no prior data)
    assert.ok(result, 'should return a metrics row');
    assert.equal(parseInt(result.active_users), 0);
    assert.equal(parseFloat(result.revenue), 0);
    assert.equal(parseFloat(result.cost), 0);
    assert.equal(parseFloat(result.net_value), 0);
  });

  it('measureProductValue computes value_ratio when cost > 0', async () => {
    const productId = 'test-product-vr';

    // Seed a metrics row with revenue and cost
    await query(
      `INSERT INTO autobot_value.product_metrics
       (product_id, measurement_date, active_users, new_users, churned_users,
        revenue, cost)
       VALUES ($1, '2026-02-10', 100, 20, 5, 500.00, 200.00)`,
      [productId]
    );

    const result = await measureProductValue(productId, '2026-02-10');
    assert.ok(result, 'should return metrics');

    // value_ratio = (500 - 200) / 200 = 1.5
    assert.equal(parseFloat(result.value_ratio).toFixed(4), '1.5000');
    // net_value = 500 - 200 = 300
    assert.equal(parseFloat(result.net_value).toFixed(6), '300.000000');
  });

  it('measureProductValue computes retention_rate from prior day', async () => {
    const productId = 'test-product-ret';

    // Day 1: 100 active users
    await query(
      `INSERT INTO autobot_value.product_metrics
       (product_id, measurement_date, active_users, new_users, churned_users,
        retained_users, revenue, cost)
       VALUES ($1, '2026-02-14', 100, 100, 0, 100, 0, 0)`,
      [productId]
    );

    // Day 2: 90 active, 10 new -> retained = 90 - 10 = 80
    await query(
      `INSERT INTO autobot_value.product_metrics
       (product_id, measurement_date, active_users, new_users, churned_users,
        revenue, cost)
       VALUES ($1, '2026-02-15', 90, 10, 20, 0, 0)`,
      [productId]
    );

    const result = await measureProductValue(productId, '2026-02-15');
    assert.ok(result, 'should return metrics');

    // retained_users = active_users - new_users = 90 - 10 = 80
    assert.equal(parseInt(result.retained_users), 80);
    // retention_rate = 80 / 100 (prev day active) = 0.8
    assert.equal(parseFloat(result.retention_rate).toFixed(4), '0.8000');
  });

  it('computeValueAssessment returns "continue" for high value ratio', async () => {
    const productId = 'test-product-assess-high';

    // Seed metrics with high value
    await query(
      `INSERT INTO autobot_value.product_metrics
       (product_id, measurement_date, active_users, revenue, cost, retention_rate)
       VALUES ($1, '2026-01-01', 100, 1000.00, 300.00, 0.9500)`,
      [productId]
    );

    const result = await computeValueAssessment(productId, 'monthly', '2026-01-01', '2026-01-31');
    assert.ok(result, 'should return assessment');
    assert.equal(result.recommendation, 'continue');
    assert.equal(result.law1_compliant, true);
    assert.equal(result.net_positive, true);
    // value_ratio = (1000 - 300) / 300 = 2.333
    assert.ok(parseFloat(result.aggregate_value_ratio) > 0.5);
  });

  it('computeValueAssessment returns "optimize" for moderate value ratio', async () => {
    const productId = 'test-product-assess-mod';

    await query(
      `INSERT INTO autobot_value.product_metrics
       (product_id, measurement_date, active_users, revenue, cost, retention_rate)
       VALUES ($1, '2026-01-15', 50, 120.00, 100.00, 0.8000)`,
      [productId]
    );

    const result = await computeValueAssessment(productId, 'weekly', '2026-01-13', '2026-01-19');
    assert.ok(result, 'should return assessment');
    assert.equal(result.recommendation, 'optimize');
    assert.equal(result.law1_compliant, true);
    // value_ratio = (120 - 100) / 100 = 0.2
    const vr = parseFloat(result.aggregate_value_ratio);
    assert.ok(vr > 0 && vr <= 0.5, `value_ratio should be between 0 and 0.5, got ${vr}`);
  });

  it('computeValueAssessment returns "sunset" for slightly negative value ratio', async () => {
    const productId = 'test-product-assess-neg';

    await query(
      `INSERT INTO autobot_value.product_metrics
       (product_id, measurement_date, active_users, revenue, cost, retention_rate)
       VALUES ($1, '2026-01-15', 30, 90.00, 100.00, 0.6000)`,
      [productId]
    );

    const result = await computeValueAssessment(productId, 'weekly', '2026-01-13', '2026-01-19');
    assert.ok(result, 'should return assessment');
    assert.equal(result.recommendation, 'sunset');
    assert.equal(result.law1_compliant, false);
    // value_ratio = (90 - 100) / 100 = -0.1
    const vr = parseFloat(result.aggregate_value_ratio);
    assert.ok(vr > -0.2 && vr <= 0, `value_ratio should be between -0.2 and 0, got ${vr}`);
  });

  it('computeValueAssessment returns "discontinue" for very negative value ratio', async () => {
    const productId = 'test-product-assess-bad';

    await query(
      `INSERT INTO autobot_value.product_metrics
       (product_id, measurement_date, active_users, revenue, cost, retention_rate)
       VALUES ($1, '2026-01-15', 10, 50.00, 200.00, 0.3000)`,
      [productId]
    );

    const result = await computeValueAssessment(productId, 'weekly', '2026-01-13', '2026-01-19');
    assert.ok(result, 'should return assessment');
    assert.equal(result.recommendation, 'discontinue');
    assert.equal(result.law1_compliant, false);
    // value_ratio = (50 - 200) / 200 = -0.75
    const vr = parseFloat(result.aggregate_value_ratio);
    assert.ok(vr <= -0.2, `value_ratio should be below -0.2, got ${vr}`);
  });

  it('getValueDashboard returns portfolio structure', async () => {
    // Register a product
    await query(
      `INSERT INTO autobot_value.products (id, name, status)
       VALUES ('dash-prod-1', 'Dashboard Test Product', 'active')
       ON CONFLICT (id) DO NOTHING`
    );

    const dashboard = await getValueDashboard();
    assert.ok(dashboard, 'should return dashboard');
    assert.ok(Array.isArray(dashboard.products), 'should have products array');
    assert.ok(dashboard.portfolio, 'should have portfolio aggregate');
    assert.ok('totalRevenue' in dashboard.portfolio, 'portfolio should have totalRevenue');
    assert.ok('totalCost' in dashboard.portfolio, 'portfolio should have totalCost');
    assert.ok('law1Compliant' in dashboard.portfolio, 'portfolio should have law1Compliant');
  });

  it('checkLaw1Compliance identifies compliant and non-compliant products', async () => {
    // Register two products
    await query(
      `INSERT INTO autobot_value.products (id, name, status) VALUES
       ('law1-good', 'Good Product', 'active'),
       ('law1-bad', 'Bad Product', 'active')
       ON CONFLICT (id) DO NOTHING`
    );

    // Good product: net positive
    await query(
      `INSERT INTO autobot_value.product_metrics
       (product_id, measurement_date, active_users, revenue, cost)
       VALUES ('law1-good', '2026-02-01', 50, 500.00, 100.00)`
    );
    await computeValueAssessment('law1-good', 'monthly', '2026-02-01', '2026-02-28');

    // Bad product: net negative
    await query(
      `INSERT INTO autobot_value.product_metrics
       (product_id, measurement_date, active_users, revenue, cost)
       VALUES ('law1-bad', '2026-02-01', 10, 50.00, 200.00)`
    );
    await computeValueAssessment('law1-bad', 'monthly', '2026-02-01', '2026-02-28');

    const compliance = await checkLaw1Compliance();
    assert.ok(compliance, 'should return compliance report');
    assert.equal(compliance.allCompliant, false, 'should not be all compliant');
    assert.ok(compliance.compliantCount >= 1, 'should have at least 1 compliant');
    assert.ok(compliance.nonCompliantCount >= 1, 'should have at least 1 non-compliant');

    const goodProd = compliance.compliant.find(p => p.id === 'law1-good');
    assert.ok(goodProd, 'good product should be in compliant list');
    assert.equal(goodProd.law1Compliant, true);

    const badProd = compliance.nonCompliant.find(p => p.id === 'law1-bad');
    assert.ok(badProd, 'bad product should be in non-compliant list');
    assert.equal(badProd.law1Compliant, false);
  });

  it('getProductHealth returns full summary for a known product', async () => {
    await query(
      `INSERT INTO autobot_value.products (id, name, status)
       VALUES ('health-prod', 'Health Test Product', 'active')
       ON CONFLICT (id) DO NOTHING`
    );

    await query(
      `INSERT INTO autobot_value.product_metrics
       (product_id, measurement_date, active_users, new_users, churned_users,
        retained_users, retention_rate, revenue, cost, value_ratio, net_value)
       VALUES ('health-prod', '2026-02-20', 80, 15, 5, 65, 0.8125, 400.00, 150.00, 1.6667, 250.00)`
    );

    await computeValueAssessment('health-prod', 'daily', '2026-02-20', '2026-02-20');

    const health = await getProductHealth('health-prod');
    assert.ok(health, 'should return health data');
    assert.equal(health.product.id, 'health-prod');
    assert.equal(health.product.name, 'Health Test Product');
    assert.ok(health.latestMetrics, 'should have latestMetrics');
    assert.equal(health.latestMetrics.activeUsers, 80);
    assert.ok(health.latestAssessment, 'should have latestAssessment');
    assert.equal(health.latestAssessment.recommendation, 'continue');
    assert.ok(Array.isArray(health.recentMetrics), 'should have recentMetrics array');
    assert.ok(Array.isArray(health.cohorts), 'should have cohorts array');
  });

  it('getProductHealth returns null for unknown product', async () => {
    const health = await getProductHealth('totally-unknown-product-xyz');
    assert.equal(health, null);
  });

  it('computeCohortRetention returns null when no new users in cohort month', async () => {
    const result = await computeCohortRetention('nonexistent-cohort-prod', '2025-06-01');
    assert.equal(result, null);
  });

  it('computeCohortRetention tracks cohort data when users exist', async () => {
    const productId = 'cohort-test-prod';

    // Seed new users in January 2026 cohort
    await query(
      `INSERT INTO autobot_value.product_metrics
       (product_id, measurement_date, active_users, new_users, churned_users, revenue, cost)
       VALUES
       ($1, '2026-01-05', 50, 30, 0, 0, 0),
       ($1, '2026-01-15', 60, 20, 5, 0, 0)`,
      [productId]
    );

    // Seed February data (month 1 retention)
    await query(
      `INSERT INTO autobot_value.product_metrics
       (product_id, measurement_date, active_users, new_users, churned_users, revenue, cost)
       VALUES ($1, '2026-02-10', 40, 5, 10, 0, 0)`,
      [productId]
    );

    const result = await computeCohortRetention(productId, '2026-01-01');
    assert.ok(result, 'should return cohort data');
    assert.equal(parseInt(result.initial_users), 50, 'initial_users should be sum of new_users in cohort month');
    assert.ok(result.retained_month_1 !== null, 'retained_month_1 should be computed');
    assert.equal(parseInt(result.retained_month_1), 40, 'retained_month_1 should reflect Feb active users');
  });
});
