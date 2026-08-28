import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newBusinessFromOpportunity, runDayForBusiness, valuation, computeNetWorth, accrueLoanInterest } from './economy.js';
import { STARTER_OPPORTUNITIES } from '../data/industries.js';

test('runDayForBusiness is deterministic given a fixed rng', () => {
  const business = newBusinessFromOpportunity({ id: 'b1', owner_id: 'p1', opportunity: STARTER_OPPORTUNITIES[0] });
  const fixedRng = () => 0.5; // no noise
  const day1 = runDayForBusiness({ ...business, activeEffects: [] }, [], fixedRng);
  const day2 = runDayForBusiness({ ...business, activeEffects: [] }, [], fixedRng);
  assert.equal(day1.revenue, day2.revenue);
  assert.equal(day1.ebitda, day2.ebitda);
});

test('runDayForBusiness never produces negative revenue', () => {
  const business = newBusinessFromOpportunity({ id: 'b2', owner_id: 'p1', opportunity: STARTER_OPPORTUNITIES[1] });
  for (let i = 0; i < 200; i++) {
    const day = runDayForBusiness({ ...business, activeEffects: [] }, [], Math.random);
    assert.ok(day.revenue >= 0);
  }
});

test('payroll reflects active employees only', () => {
  const business = newBusinessFromOpportunity({ id: 'b3', owner_id: 'p1', opportunity: STARTER_OPPORTUNITIES[0] });
  const employees = [{ salary_monthly: 3000 }, { salary_monthly: 1500 }];
  const day = runDayForBusiness({ ...business, activeEffects: [] }, employees, () => 0.5);
  assert.equal(day.payroll, Math.round(4500 / 30));
});

test('valuation converges to the run-rate multiple once fully ramped', () => {
  const business = newBusinessFromOpportunity({ id: 'b4', owner_id: 'p1', opportunity: STARTER_OPPORTUNITIES[2] });
  const financials = Array.from({ length: 30 }, () => ({ ebitda: 200 })); // full 30-day ramp
  const v = valuation(business, financials);
  // car_detailing multiple is 3x the monthly run-rate EBITDA
  assert.equal(v, Math.round(200 * 30 * 3));
});

test('valuation equals cost basis with no trailing financials (no instant value from an unproven business)', () => {
  const business = newBusinessFromOpportunity({ id: 'b5', owner_id: 'p1', opportunity: STARTER_OPPORTUNITIES[0] });
  assert.equal(valuation(business, []), STARTER_OPPORTUNITIES[0].cost);
});

test('valuation ramps gradually between cost basis and run-rate value, never jumping on day one', () => {
  const business = newBusinessFromOpportunity({ id: 'b6', owner_id: 'p1', opportunity: STARTER_OPPORTUNITIES[0] });
  const oneDayValuation = valuation(business, [{ ebitda: 2000 }]); // an implausibly great single day
  const fullRunRate = 2000 * 30 * 2.5;
  assert.ok(oneDayValuation < fullRunRate, 'one day of data should not grant the full multiple-based value');
  assert.ok(oneDayValuation > 0);
});

test('a freshly acquired business keeps its purchase-price valuation instead of crashing to $0', () => {
  const business = newBusinessFromOpportunity({
    id: 'b7', owner_id: 'p1',
    opportunity: { industry: 'ecommerce', cost: 114798, baseRevenuePerDay: 1000 },
    costBasis100: 114798,
  });
  assert.equal(valuation(business, []), 114798);
});

test('computeNetWorth subtracts debt and sums assets', () => {
  const nw = computeNetWorth({
    cash: 1000, businessValuations: [50000, 20000], propertyValues: [100000],
    loanBalances: [30000], investmentValues: [5000],
  });
  assert.equal(nw, 1000 + 50000 + 20000 + 100000 + 5000 - 30000);
});

test('loan interest accrues daily at the annual rate', () => {
  const loan = { balance: 10000, annual_rate: 0.365 }; // 0.1% per day
  const newBalance = accrueLoanInterest(loan, 1);
  assert.ok(newBalance > 10000);
  assert.ok(newBalance < 10011); // roughly +$10
});
