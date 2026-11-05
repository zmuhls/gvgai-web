const test = require('node:test');
const assert = require('node:assert/strict');
const FramePacer = require('../public/js/frame-pacer');

test('paces six real frames across a model wait instead of showing a 25ms burst', () => {
  const pacer = new FramePacer();
  pacer.observeDecision(0,0,750,100,6);
  const drawn=[];
  for (let now=0;now<1100;now++) {
    if (now%25===0 && now<=125) pacer.push({tick:now/25},now);
    if (pacer.queue.length && pacer.delay(now)===0) {
      const frame=pacer.take(now);
      drawn.push({at:now,tick:frame.tick});
      pacer.lastDrawAt=now;
    }
  }
  assert.deepEqual(drawn.map(x=>x.tick),[0,1,2,3,4,5]);
  assert.ok(drawn.at(-1).at>=800,'Spread the burst over the model wait');
  assert.ok(drawn.at(-1).at<1000,'Do not create excessive playback delay');
  assert.ok(drawn.slice(1).every((x,i)=>x.at-drawn[i].at<180));
  assert.equal(pacer.dropped,0);
});

test('human play and finished runs draw the newest frame immediately', () => {
  for (const finish of [false,true]) {
    const pacer=new FramePacer();
    pacer.reset(finish);
    pacer.lastDrawAt=20;
    pacer.push({tick:1},20);pacer.push({tick:2},21);
    if(finish)pacer.finish();
    assert.equal(pacer.delay(21),0);
    assert.equal(pacer.take(21).tick,2);
    assert.equal(pacer.queue.length,0);
  }
});

test('bounds memory and discards old frames after a tab suspension or reset', () => {
  const pacer=new FramePacer();
  for(let tick=0;tick<50;tick++)pacer.push({tick},tick*10);
  assert.equal(pacer.queue.length,12);
  assert.equal(pacer.take(5000).tick,49);
  assert.equal(pacer.dropped,49);
  pacer.push({tick:50},5001);pacer.reset();
  assert.equal(pacer.take(5001),null);
});

test('learns actual ticks per decision when a guarded hold stops early', () => {
  const pacer=new FramePacer();
  pacer.observeDecision(0,0,750,100,6);
  const initial=pacer.intervalMs;
  pacer.observeDecision(2,1000,750,100,6);
  assert.ok(pacer.intervalMs>initial);
  pacer.observeDecision(3,20000,19000,100,1);
  assert.equal(pacer.intervalMs,350);
});
