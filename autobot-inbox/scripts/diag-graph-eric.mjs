#!/usr/bin/env node
// OPT-136 one-off diagnostic: why did person_connections("eric@staqs.io") return
// 0 rows? Connect to the prod graph via the PUBLIC TCP proxy (internal host is
// unreachable from a laptop). Creds read from env (inject via `railway run`):
//   railway run --service autobot-inbox-api node autobot-inbox/scripts/diag-graph-eric.mjs
import neo4j from 'neo4j-driver';

const uri = 'bolt://junction.proxy.rlwy.net:23481';
const user = process.env.NEO4J_USER || 'neo4j';
const password = process.env.NEO4J_PASSWORD;
if (!password) { console.error('NEO4J_PASSWORD not in env'); process.exit(1); }

const driver = neo4j.driver(uri, neo4j.auth.basic(user, password), { connectionAcquisitionTimeout: 8000 });
const s = driver.session({ defaultAccessMode: neo4j.session.READ });
const num = (v) => (v && typeof v.toNumber === 'function' ? v.toNumber() : v);

try {
  await driver.verifyConnectivity();
  console.log('connected to', uri);

  console.log('\n1) Person nodes matching "eric" (email or name):');
  let r = await s.run(
    `MATCH (p:Person) WHERE toLower(coalesce(p.email,'')) CONTAINS 'eric' OR toLower(coalesce(p.name,'')) CONTAINS 'eric'
     RETURN p.email AS email, p.name AS name, p.origin_org AS org, p.contact_type AS ct LIMIT 15`);
  for (const rec of r.records) { const o = rec.toObject(); console.log(`   - ${o.email || '(no email)'} | ${o.name || '(no name)'} | org=${o.org} | ct=${o.ct}`); }
  if (r.records.length === 0) console.log('   (none)');

  console.log('\n2) Exact node eric@staqs.io?');
  r = await s.run(`MATCH (p:Person {email:'eric@staqs.io'}) RETURN count(p) AS n`);
  const exact = num(r.records[0]?.get('n')) || 0;
  console.log(`   count = ${exact}`);

  console.log('\n3) Co-attendance degree for eric@staqs.io:');
  r = await s.run(
    `MATCH (p:Person {email:'eric@staqs.io'})-[rel:THREADED_WITH|PARTICIPATED_WITH|COLLABORATED_ON_PROJECT]-(o:Person)
     RETURN count(rel) AS deg`);
  console.log(`   degree = ${num(r.records[0]?.get('deg')) || 0}`);

  console.log('\n4) Top-5 Persons by co-attendance degree (who DOES have edges):');
  r = await s.run(
    `MATCH (p:Person)-[rel:THREADED_WITH|PARTICIPATED_WITH|COLLABORATED_ON_PROJECT]-(:Person)
     RETURN p.email AS email, p.name AS name, count(rel) AS deg ORDER BY deg DESC LIMIT 5`);
  for (const rec of r.records) { const o = rec.toObject(); console.log(`   - ${o.email || o.name} : ${num(o.deg)}`); }
} catch (e) {
  console.error('ERROR:', e.message);
} finally {
  await s.close(); await driver.close();
}
