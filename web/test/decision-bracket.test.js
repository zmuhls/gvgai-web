const test=require('node:test');
const assert=require('node:assert/strict');
const {compare,standings}=require('../scripts/run-decision-bracket');
const row=(modelId,winner,score,ticks=50)=>({gameId:1,modelId,winner,score,ticks,valid:true});
test('bracket prioritizes engine wins, preserves unfinished draws and ignores latency',()=>{
  assert.equal(compare(row('a','PLAYER_WINS',1),row('b','NO_WINNER',99)),1);
  assert.equal(compare(row('a','NO_WINNER',1),row('b','PLAYER_LOSES',99)),1);
  assert.equal(compare({...row('a','NO_WINNER',5),medianMs:200},{...row('b','NO_WINNER',5),medianMs:900}),0);
  assert.equal(compare(row('a','PLAYER_WINS',1,10),row('b','PLAYER_WINS',1,20)),1);
  assert.equal(compare({...row('a','PLAYER_WINS',99),valid:false},row('b','PLAYER_LOSES',0)),-1);
});
test('per-game points do not let one high-scoring game swamp other games',()=>{
  const result=standings([row('a','NO_WINNER',99999),row('b','NO_WINNER',1),
    {...row('a','NO_WINNER',0),gameId:2},{...row('b','PLAYER_WINS',1),gameId:2}], [{id:'a'},{id:'b'}]);
  assert.equal(result[0].modelId,'b');
  assert.equal(result[0].points,result[1].points);
  assert.equal(result[0].wins,1);
});
test('repeated games only compare matching levels and seeds',()=>{
  const rows=[{...row('a','NO_WINNER',100),levelId:0,seed:7},{...row('b','NO_WINNER',0),levelId:0,seed:7},
    {...row('a','NO_WINNER',0),levelId:4,seed:2026},{...row('b','NO_WINNER',1),levelId:4,seed:2026}];
  assert.deepEqual(standings(rows,[{id:'a'},{id:'b'}]).map(r=>r.points),[1,1]);
});
