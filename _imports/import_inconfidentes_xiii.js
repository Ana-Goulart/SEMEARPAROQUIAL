const mysql = require('/SemearParoquial/SemearJovens/node_modules/mysql2/promise');
const { execFileSync } = require('child_process');

const DB = {
  host: '127.0.0.1',
  user: 'infra',
  password: 'M4n3r@@G1nx',
  database: 'db_semeajovens'
};

const TENANT_ID = 9;
function stripAccents(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function parseWorkbook() {
  const output = execFileSync('python3', ['/SemearParoquial/_imports/extract_inconfidentes_xiii.py'], {
    encoding: 'utf8'
  });
  return JSON.parse(output);
}

async function main() {
  const jovens = parseWorkbook();
  const conn = await mysql.createConnection(DB);

  try {
    await conn.beginTransaction();

    const [[tenant]] = await conn.query(
      'SELECT id, nome_ejc, paroquia FROM tenants_ejc WHERE id = ? LIMIT 1',
      [TENANT_ID]
    );
    if (!tenant) throw new Error('Tenant Inconfidentes não encontrado');

    await conn.query('DELETE FROM historico_equipes WHERE tenant_id = ?', [TENANT_ID]);
    await conn.query('DELETE FROM jovens WHERE tenant_id = ?', [TENANT_ID]);
    await conn.query('DELETE FROM outros_ejcs WHERE tenant_id = ?', [TENANT_ID]);
    await conn.query('DELETE FROM circulos WHERE tenant_id = ?', [TENANT_ID]);
    await conn.query('DELETE FROM equipes_ejc WHERE tenant_id = ?', [TENANT_ID]);
    await conn.query('DELETE FROM equipes WHERE tenant_id = ?', [TENANT_ID]);
    await conn.query('DELETE FROM ejc WHERE tenant_id = ?', [TENANT_ID]);

    const equipeNames = [
      'Cozinha',
      'Cafezinho',
      'Sala',
      'Apoio e Acolhida',
      'Ordem',
      'Liturgia Interna',
      'Liturgia Externa',
      'Tios',
      'Finanças',
      'Geral',
      'Secretaria'
    ];

    const equipeIds = new Map();
    for (const nome of equipeNames) {
      const [result] = await conn.query(
        'INSERT INTO equipes (nome, tenant_id) VALUES (?, ?)',
        [nome, TENANT_ID]
      );
      equipeIds.set(nome, result.insertId);
    }

    const ejcIds = new Map();
    for (let numero = 1; numero <= 12; numero++) {
      const [result] = await conn.query(
        'INSERT INTO ejc (numero, paroquia, tenant_id) VALUES (?, ?, ?)',
        [numero, tenant.paroquia, TENANT_ID]
      );
      ejcIds.set(numero, result.insertId);
    }

    for (const ejcId of ejcIds.values()) {
      for (const equipeId of equipeIds.values()) {
        await conn.query(
          'INSERT INTO equipes_ejc (ejc_id, equipe_id, tenant_id) VALUES (?, ?, ?)',
          [ejcId, equipeId, TENANT_ID]
        );
      }
    }

    const circleRows = [
      ['Azul', '#00B0F0', 1],
      ['Amarelo', '#FFFF00', 2],
      ['Rosa', '#FF3399', 3],
      ['Verde', '#00B050', 4],
      ['Vermelho', '#FF0000', 5],
      ['Marrom', '#7F6000', 6]
    ];
    for (const [nome, cor_hex, ordem] of circleRows) {
      await conn.query(
        'INSERT INTO circulos (tenant_id, nome, cor_hex, ordem, ativo) VALUES (?, ?, ?, ?, 1)',
        [TENANT_ID, nome, cor_hex, ordem]
      );
    }

    const outrosEjcIds = new Map();
    for (const jovem of jovens) {
      if (jovem.origemInfo.origem !== 'OUTRO_EJC') continue;
      const key = stripAccents(jovem.origemInfo.nome).toLowerCase();
      if (outrosEjcIds.has(key)) continue;
      const [result] = await conn.query(
        'INSERT INTO outros_ejcs (tenant_id, paroquia, nome, bairro, observacoes) VALUES (?, ?, ?, ?, ?)',
        [TENANT_ID, jovem.origemInfo.nome, null, 'Não informado', 'Criado automaticamente pela importação da planilha XIII']
      );
      outrosEjcIds.set(key, result.insertId);
    }

    for (const jovem of jovens) {
      const origemTipo = jovem.origemInfo.origem === 'OUTRO_EJC' ? 'OUTRO_EJC' : 'INCONFIDENTES';
      const numeroEjcFez = origemTipo === 'INCONFIDENTES'
        ? (ejcIds.get(jovem.origemInfo.numero) || null)
        : null;
      const outroEjcId = origemTipo === 'OUTRO_EJC'
        ? (outrosEjcIds.get(stripAccents(jovem.origemInfo.nome).toLowerCase()) || null)
        : null;
      const outroEjcNumero = origemTipo === 'OUTRO_EJC' && jovem.origemInfo.numero
        ? String(jovem.origemInfo.numero)
        : null;

      const [insertResult] = await conn.query(
        `INSERT INTO jovens (
          tenant_id, nome_completo, telefone, instagram, data_nascimento,
          numero_ejc_fez, origem_ejc_tipo, outro_ejc_id, outro_ejc_numero,
          estado_civil, circulo, lista_mestre_ativo, transferencia_outro_ejc,
          ja_foi_moita_inconfidentes, deficiencia, restricao_alimentar, nao_serve_ejc, paroquia
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Solteiro', ?, 1, 0, 0, 0, 0, 0, ?)`,
        [
          TENANT_ID,
          jovem.nome,
          jovem.telefone,
          jovem.instagram,
          jovem.data_nascimento,
          numeroEjcFez,
          origemTipo,
          outroEjcId,
          outroEjcNumero,
          jovem.circulo,
          origemTipo === 'OUTRO_EJC' ? jovem.origemInfo.nome : tenant.paroquia
        ]
      );

      for (const hist of jovem.historico) {
        const ejcId = ejcIds.get(hist.numero);
        if (!ejcId) continue;
        await conn.query(
          'INSERT INTO historico_equipes (tenant_id, jovem_id, edicao_ejc, equipe, papel, ejc_id) VALUES (?, ?, ?, ?, ?, ?)',
          [TENANT_ID, insertResult.insertId, `${hist.numero}º EJC`, hist.equipe, 'Membro', ejcId]
        );
      }
    }

    await conn.commit();

    const [[resumo]] = await conn.query(
      `SELECT
         (SELECT COUNT(*) FROM jovens WHERE tenant_id = ?) AS jovens,
         (SELECT COUNT(*) FROM historico_equipes WHERE tenant_id = ?) AS historico_equipes,
         (SELECT COUNT(*) FROM equipes WHERE tenant_id = ?) AS equipes,
         (SELECT COUNT(*) FROM ejc WHERE tenant_id = ?) AS ejcs,
         (SELECT COUNT(*) FROM circulos WHERE tenant_id = ?) AS circulos,
         (SELECT COUNT(*) FROM outros_ejcs WHERE tenant_id = ?) AS outros_ejcs`,
      [TENANT_ID, TENANT_ID, TENANT_ID, TENANT_ID, TENANT_ID, TENANT_ID]
    );

    console.log(JSON.stringify({ tenant: tenant.nome_ejc, ...resumo }, null, 2));
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
