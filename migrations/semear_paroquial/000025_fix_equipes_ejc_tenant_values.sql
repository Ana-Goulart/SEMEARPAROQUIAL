DELETE ee_bad
FROM equipes_ejc ee_bad
JOIN ejc e ON e.id = ee_bad.ejc_id
JOIN equipes eq ON eq.id = ee_bad.equipe_id
JOIN equipes_ejc ee_good
  ON ee_good.tenant_id = e.tenant_id
 AND ee_good.ejc_id = ee_bad.ejc_id
 AND ee_good.equipe_id = ee_bad.equipe_id
WHERE ee_bad.tenant_id <> e.tenant_id
   OR ee_bad.tenant_id <> eq.tenant_id;

UPDATE equipes_ejc ee
JOIN ejc e ON e.id = ee.ejc_id
JOIN equipes eq ON eq.id = ee.equipe_id
SET ee.tenant_id = e.tenant_id
WHERE e.tenant_id = eq.tenant_id
  AND (ee.tenant_id <> e.tenant_id OR ee.tenant_id <> eq.tenant_id);

DELETE ee
FROM equipes_ejc ee
LEFT JOIN ejc e ON e.id = ee.ejc_id
LEFT JOIN equipes eq ON eq.id = ee.equipe_id
WHERE e.id IS NULL
   OR eq.id IS NULL
   OR e.tenant_id <> eq.tenant_id
   OR ee.tenant_id <> e.tenant_id
   OR ee.tenant_id <> eq.tenant_id;
