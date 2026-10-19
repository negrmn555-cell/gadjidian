import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureRun, measure, recordCache, recordProvider, withoutMeasurements, type RunMeasurements } from '../src/metrics.js';

test('run measurements isolate concurrent requests, mark failed stages and exclude background work',async()=>{
  const reports:RunMeasurements[]=[];
  await Promise.all([measureRun(async()=>{
    await assert.rejects(measure('provider',async()=>{recordProvider(100,{promptTokens:12,completionTokens:3});throw new Error('PRIVATE_EXCEPTION_FIXTURE');}));
    await withoutMeasurements(()=>measure('search',async()=>{recordCache(false);}));recordCache(true);return {outcome:'partial'};
  },r=>reports.push(r)),measureRun(async()=>{await measure('context',async()=>{});return {outcome:'success'};},r=>reports.push(r))]);
  const partial=reports.find(r=>r.outcome==='partial')!,other=reports.find(r=>r.outcome==='success')!;
  assert.equal(partial.providerCalls,1);assert.equal(partial.promptTokens,12);assert.equal(partial.cacheHits,1);assert.equal(partial.cacheMisses,undefined);assert.equal(partial.timeline!.length,1);assert.equal(partial.timeline![0].failed,true);assert.equal(partial.stages.search,undefined);
  assert.equal(other.providerCalls,0);assert.equal(other.timeline![0].stage,'context');assert(!JSON.stringify(reports).includes('PRIVATE_EXCEPTION_FIXTURE'));
});
