import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,addDocument,extract,snapshot } from './information-records-fixture.mjs';
import { hasRetainedExtraction,reconcileUnextractedPairs } from './information-records-reconcile.mjs';

for (const records of [true,false]) test(`reconciliation protects successful ${records?'nonempty':'empty'} extraction`,()=>{
  const f=fixture();try {const keep=addDocument(f.db),drop=addDocument(f.db);extract(f,drop,records?undefined:[]);
    const pair={keep:snapshot(f,keep.id),drop:snapshot(f,drop.id)};
    assert.equal(hasRetainedExtraction(pair.drop),true);
    assert.throws(()=>reconcileUnextractedPairs([pair],f.options),/cannot delete extracted/);
    assert.equal(f.db.prepare('SELECT count(*) n FROM knowledge_docs').get().n,2);
  }finally{f.close();}
});

test('reconciliation rechecks concurrent changes before deleting or merging anything',()=>{
  const f=fixture();try {const keep=addDocument(f.db),drop=addDocument(f.db);
    const pair={keep:snapshot(f,keep.id),drop:snapshot(f,drop.id)};
    f.db.prepare("UPDATE knowledge_docs SET title='new title' WHERE doc_id=?").run(drop.id);
    assert.throws(()=>reconcileUnextractedPairs([pair],f.options),/input changed/);
    assert.equal(f.db.prepare('SELECT count(*) n FROM knowledge_docs').get().n,2);
    assert.equal(snapshot(f,keep.id).metadata_json,pair.keep.metadata_json);
  }finally{f.close();}
});

test('unextracted repeats merge sources without disturbing retained successful records',()=>{
  const f=fixture();try {const keep=addDocument(f.db),drop=addDocument(f.db,{meta:{feed:{sources:[{sourceKey:'another',url:'https://example.invalid/second'}]}}});
    extract(f,keep);const pair={keep:snapshot(f,keep.id),drop:snapshot(f,drop.id)};
    assert.equal(reconcileUnextractedPairs([pair],f.options),1);
    const after=snapshot(f,keep.id);assert.deepEqual(after.records,pair.keep.records);
    assert.deepEqual(after.meta.informationExtraction,pair.keep.meta.informationExtraction);assert.equal(after.meta.feed.sources.length,2);
    assert.equal(f.db.prepare('SELECT count(*) n FROM knowledge_docs').get().n,1);assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{f.close();}
});

test('reconciliation refuses published documents and cyclic pairs',()=>{
  const f=fixture();try {const a=addDocument(f.db),b=addDocument(f.db);
    const pair={keep:snapshot(f,a.id),drop:snapshot(f,b.id)};
    assert.throws(()=>reconcileUnextractedPairs([pair,{keep:pair.drop,drop:pair.keep}],f.options),/cyclic/);
    f.db.prepare("UPDATE knowledge_docs SET metadata_json=json_set(metadata_json,'$.feed.publishAllowed',json('true')) WHERE doc_id=?").run(b.id);
    assert.throws(()=>reconcileUnextractedPairs([{keep:snapshot(f,a.id),drop:snapshot(f,b.id)}],f.options),/published/);
  }finally{f.close();}
});
