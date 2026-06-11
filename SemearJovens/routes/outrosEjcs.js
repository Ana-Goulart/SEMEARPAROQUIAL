const express = require('express');
const router = express.Router();
const db = require('../database');
const { getTenantId } = require('../lib/tenantIsolation');
const {
    decryptJovemRecord,
    encryptJovemCpf,
    encryptJovemPhone,
    ensureJovensSensitiveColumns,
    jovemCpfHash,
    jovemPhoneHash
} = require('../lib/jovensSensitiveData');

async function hasTable(tableName) {
    const [rows] = await db.pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
    `, [tableName]);
    return !!(rows && rows[0] && rows[0].cnt > 0);
}

async function hasColumn(tableName, columnName) {
    const [rows] = await db.pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?
    `, [tableName, columnName]);
    return !!(rows && rows[0] && rows[0].cnt > 0);
}

function normalizarTextoBusca(valor) {
    return String(valor || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function normalizarTextoOuNull(valor, maxLen = null) {
    if (valor === undefined || valor === null) return null;
    const texto = String(valor).trim();
    if (!texto) return null;
    if (maxLen && texto.length > maxLen) {
        throw new Error(`Campo texto fora do padrão: máximo de ${maxLen} caracteres.`);
    }
    return texto;
}

function normalizarNomePessoa(valor) {
    const texto = normalizarTextoOuNull(valor, 180);
    return texto ? texto.toLocaleUpperCase('pt-BR') : null;
}

function normalizarDataPlanilha(valor) {
    const texto = String(valor || '').trim();
    if (!texto) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) return texto;
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(texto)) return texto.split('/').reverse().join('-');
    return texto;
}

function numeroParaRomano(num) {
    const mapa = [
        [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
        [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
        [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']
    ];
    let n = Number(num) || 0;
    let out = '';
    for (const [valor, romano] of mapa) {
        while (n >= valor) {
            out += romano;
            n -= valor;
        }
    }
    return out;
}

function romanoParaNumero(valor) {
    const texto = String(valor || '').trim().toUpperCase();
    if (!/^[IVXLCDM]+$/.test(texto)) return null;
    const mapa = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    let total = 0;
    for (let i = 0; i < texto.length; i += 1) {
        const atual = mapa[texto[i]] || 0;
        const prox = mapa[texto[i + 1]] || 0;
        total += atual < prox ? -atual : atual;
    }
    return total > 0 ? total : null;
}

function normalizarNumeroEjc(valor) {
    const texto = String(valor || '').trim();
    if (!texto) return null;
    const numero = Number(texto);
    if (Number.isFinite(numero) && numero > 0) return String(Math.trunc(numero));
    const semAcento = texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
    const digitos = semAcento.match(/\d+/);
    if (digitos) return String(Number(digitos[0]));
    const romano = semAcento.match(/\b[IVXLCDM]+\b/);
    const romanoNumero = romano ? romanoParaNumero(romano[0]) : null;
    return romanoNumero ? String(romanoNumero) : texto;
}

function parseServicoEquipe(valor) {
    const texto = String(valor || '').trim();
    if (!texto) return null;
    let equipe = texto;
    let papel = 'Membro';
    let subfuncao = null;
    const match = texto.match(/^(.*?)\s*\((.*?)\)\s*$/);
    if (match) {
        equipe = String(match[1] || '').trim();
        const etiqueta = String(match[2] || '').trim();
        if (etiqueta.includes(' - ')) {
            const [papelExtraido, ...resto] = etiqueta.split(' - ');
            papel = String(papelExtraido || '').trim() || 'Membro';
            subfuncao = resto.join(' - ').trim() || null;
        } else if (etiqueta) {
            const papelNormalizado = etiqueta.toLowerCase() === 'coord' ? 'Coordenador' : etiqueta;
            if (['Membro', 'Tio', 'Tios', 'Coordenador'].includes(papelNormalizado)) {
                papel = papelNormalizado;
            } else {
                subfuncao = etiqueta;
            }
        }
    }
    equipe = normalizarTextoOuNull(equipe, 180);
    if (!equipe) return null;
    return {
        equipe,
        papel: normalizarTextoOuNull(papel, 50) || 'Membro',
        subfuncao: normalizarTextoOuNull(subfuncao, 120)
    };
}

let ensureOutrosEjcsObsPromise = null;

async function ensureObservacoesStructure() {
    if (ensureOutrosEjcsObsPromise) return ensureOutrosEjcsObsPromise;
    ensureOutrosEjcsObsPromise = (async () => {
        if (!await hasColumn('outros_ejcs', 'observacoes')) {
            try {
                await db.pool.query('ALTER TABLE outros_ejcs ADD COLUMN observacoes VARCHAR(255) NULL AFTER bairro');
            } catch (err) {
                if (!err || err.code !== 'ER_DUP_FIELDNAME') throw err;
            }
        }

        await db.pool.query(`
            CREATE TABLE IF NOT EXISTS outros_ejcs_observacoes_extras (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tenant_id INT NOT NULL,
                outro_ejc_id INT NOT NULL,
                observacao TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                KEY idx_outros_ejcs_obs_tenant_outro (tenant_id, outro_ejc_id)
            )
        `);
    })();
    try {
        await ensureOutrosEjcsObsPromise;
    } finally {
        ensureOutrosEjcsObsPromise = null;
    }
}

// GET /api/outros-ejcs
router.get('/', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        await ensureObservacoesStructure();
        const [rows] = await db.pool.query('SELECT * FROM outros_ejcs WHERE tenant_id = ? ORDER BY created_at DESC', [tenantId]);
        res.json(rows);
    } catch (error) {
        console.error("Erro ao listar outros EJCs:", error);
        res.status(500).json({ error: 'Erro ao listar outros EJCs' });
    }
});

// GET /api/outros-ejcs/:id/presencas
router.get('/:id/presencas', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'ID inválido.' });
    }

    try {
        const tenantId = getTenantId(req);
        const hasPresencas = await hasTable('formularios_presencas');
        const hasFormularios = await hasTable('formularios_itens');
        const hasOutroEjcId = hasPresencas ? await hasColumn('formularios_presencas', 'outro_ejc_id') : false;
        if (!hasPresencas || !hasFormularios || !hasOutroEjcId) return res.json([]);

        const [rows] = await db.pool.query(`
            SELECT
                fp.id,
                fp.nome_completo,
                fp.telefone,
                fp.registrado_em,
                fi.titulo AS evento_titulo,
                fi.evento_data
            FROM formularios_presencas fp
            JOIN formularios_itens fi ON fi.id = fp.formulario_id
            WHERE fp.outro_ejc_id = ?
              AND fp.tenant_id = ?
            ORDER BY fp.registrado_em DESC
        `, [id, tenantId]);

        const map = new Map();
        for (const row of rows) {
            const nome = String(row.nome_completo || '').trim() || 'Sem nome';
            const telefone = String(row.telefone || '').trim() || '';
            const key = `${nome}::${telefone}`;
            const evento = {
                titulo: row.evento_titulo || 'Evento sem título',
                data: row.evento_data || null,
                registrado_em: row.registrado_em || null
            };

            if (!map.has(key)) {
                map.set(key, {
                    nome_completo: nome,
                    telefone: telefone || '-',
                    eventos: [evento]
                });
            } else {
                map.get(key).eventos.push(evento);
            }
        }

        return res.json(Array.from(map.values()));
    } catch (error) {
        console.error('Erro ao listar presenças por outro EJC:', error);
        return res.status(500).json({ error: 'Erro ao listar presenças.' });
    }
});

// GET /api/outros-ejcs/:id/conjuges
router.get('/:id/conjuges', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'ID inválido.' });
    }

    try {
        const tenantId = getTenantId(req);
        const hasJovens = await hasTable('jovens');
        if (!hasJovens) return res.json([]);
        await ensureJovensSensitiveColumns(db.pool);

        const hasConjugeOutroEjcId = await hasColumn('jovens', 'conjuge_outro_ejc_id');
        const hasConjugeNome = await hasColumn('jovens', 'conjuge_nome');
        const hasConjugeTelefone = await hasColumn('jovens', 'conjuge_telefone');
        if (!hasConjugeOutroEjcId || !hasConjugeNome || !hasConjugeTelefone) return res.json([]);

        const [rows] = await db.pool.query(`
            SELECT
                j.id AS jovem_id,
                j.nome_completo AS jovem_nome,
                j.telefone AS jovem_telefone,
                j.conjuge_nome,
                j.conjuge_telefone
            FROM jovens j
            WHERE j.conjuge_outro_ejc_id = ?
              AND j.tenant_id = ?
              AND COALESCE(TRIM(j.conjuge_nome), '') <> ''
            ORDER BY j.conjuge_nome ASC, j.nome_completo ASC
        `, [id, tenantId]);

        const payload = rows.map((row) => {
            const r = decryptJovemRecord({
                conjuge_telefone: row.conjuge_telefone,
                telefone: row.jovem_telefone
            });
            return {
                jovem_id: row.jovem_id,
                jovem_nome: row.jovem_nome || '-',
                conjuge_nome: row.conjuge_nome || '-',
                telefone: r.conjuge_telefone || r.telefone || '-'
            };
        });

        return res.json(payload);
    } catch (error) {
        console.error('Erro ao listar cônjuges por outro EJC:', error);
        return res.status(500).json({ error: 'Erro ao listar cônjuges.' });
    }
});

router.get('/:id/jovens', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'ID inválido.' });
    }

    try {
        const tenantId = getTenantId(req);
        await ensureJovensSensitiveColumns(db.pool);
        const [rows] = await db.pool.query(
            `SELECT j.id, j.nome_completo, j.telefone, j.outro_ejc_numero,
                    j.estado_civil, j.sexo, j.circulo
             FROM jovens j
             WHERE j.tenant_id = ?
               AND j.origem_ejc_tipo = 'OUTRO_EJC'
               AND COALESCE(j.transferencia_outro_ejc, 0) = 0
               AND j.outro_ejc_id = ?
             ORDER BY j.nome_completo ASC`,
            [tenantId, id]
        );
        return res.json((rows || []).map((row) => decryptJovemRecord(row)));
    } catch (error) {
        console.error('Erro ao listar jovens do outro EJC:', error);
        return res.status(500).json({ error: 'Erro ao listar jovens deste outro EJC.' });
    }
});

router.post('/importar-jovens', async (req, res) => {
    const itens = Array.isArray(req.body) ? req.body : [];
    if (!itens.length) return res.status(400).json({ error: 'Nenhum jovem informado para importação.' });

    const connection = await db.pool.getConnection();
    let criados = 0;
    let atualizados = 0;
    let historicos = 0;
    let erros = 0;
    const detalhesErros = [];

    try {
        const tenantId = getTenantId(req);
        await ensureJovensSensitiveColumns(db.pool);

        const colunasObrigatorias = [
            ['jovens', 'origem_ejc_tipo'],
            ['jovens', 'outro_ejc_id'],
            ['jovens', 'outro_ejc_numero']
        ];
        for (const [tabela, coluna] of colunasObrigatorias) {
            if (!await hasColumn(tabela, coluna)) {
                return res.status(500).json({ error: `A coluna ${tabela}.${coluna} não existe na base atual.` });
            }
        }

        const hasHistorico = await hasTable('historico_equipes');
        const hasHistoricoSubfuncao = hasHistorico ? await hasColumn('historico_equipes', 'subfuncao') : false;
        const hasHistoricoEdicao = hasHistorico ? await hasColumn('historico_equipes', 'edicao_ejc') : false;
        const hasHistoricoEjcId = hasHistorico ? await hasColumn('historico_equipes', 'ejc_id') : false;
        const hasHistoricoSnapshots = hasHistorico
            ? {
                nome: await hasColumn('historico_equipes', 'nome_completo_snapshot'),
                telefone: await hasColumn('historico_equipes', 'telefone_snapshot'),
                origem: await hasColumn('historico_equipes', 'origem_ejc_tipo_snapshot'),
                outroNumero: await hasColumn('historico_equipes', 'outro_ejc_numero_snapshot'),
                outroId: await hasColumn('historico_equipes', 'outro_ejc_id_snapshot'),
                outroNome: await hasColumn('historico_equipes', 'outro_ejc_nome_snapshot'),
                outroParoquia: await hasColumn('historico_equipes', 'outro_ejc_paroquia_snapshot')
            }
            : {};

        const [outrosRows] = await connection.query(
            'SELECT id, nome, paroquia FROM outros_ejcs WHERE tenant_id = ?',
            [tenantId]
        );
        const outrosPorId = new Map((outrosRows || []).map((row) => [Number(row.id), row]));
        const outrosPorNome = new Map();
        (outrosRows || []).forEach((row) => {
            const nome = normalizarTextoBusca(row.nome);
            if (nome) outrosPorNome.set(nome, row);
            const nomeComPrefixo = normalizarTextoBusca(`EJC ${row.nome || ''}`);
            if (nomeComPrefixo) outrosPorNome.set(nomeComPrefixo, row);
        });
        const [ejcRows] = await connection.query(
            'SELECT id, numero FROM ejc WHERE tenant_id = ?',
            [tenantId]
        );
        const ejcsPorNumero = new Map(
            (ejcRows || [])
                .filter((row) => Number(row.numero) > 0)
                .map((row) => [Number(row.numero), row])
        );

        const estadosCivisValidos = new Map([
            ['solteiro', 'Solteiro'],
            ['noivo', 'Noivo'],
            ['casado', 'Casado'],
            ['amasiado', 'Amasiado']
        ]);
        const sexosValidos = new Set(['Feminino', 'Masculino']);

        await connection.beginTransaction();

        for (let i = 0; i < itens.length; i += 1) {
            const item = itens[i] || {};
            const jovem = item.jovem || {};
            const linha = Number(item.linha || i + 2);
            let nomeJovem = String(jovem.nome_completo || '').trim() || 'Registro sem nome';

            try {
                const outroId = Number(jovem.outro_ejc_id);
                const outroEjc = outrosPorId.get(outroId)
                    || outrosPorNome.get(normalizarTextoBusca(jovem.outro_ejc_nome))
                    || outrosPorNome.get(normalizarTextoBusca(`EJC ${jovem.outro_ejc_nome || ''}`));
                if (!outroEjc) throw new Error(`Outro EJC não encontrado: "${jovem.outro_ejc_nome || jovem.outro_ejc_id || ''}".`);

                const nomeCompleto = normalizarNomePessoa(jovem.nome_completo);
                if (!nomeCompleto) throw new Error('Campo nome_completo é obrigatório.');
                nomeJovem = nomeCompleto;

                const telefoneTexto = normalizarTextoOuNull(jovem.telefone, 30);
                if (telefoneTexto) {
                    const digitos = telefoneTexto.replace(/\D/g, '');
                    if (digitos.length < 10 || digitos.length > 11) {
                        throw new Error(`Campo telefone fora do padrão: "${telefoneTexto}". Use 10 ou 11 dígitos.`);
                    }
                }

                const estadoCivilTexto = normalizarTextoOuNull(jovem.estado_civil, 30) || 'Solteiro';
                const estadoCivil = estadosCivisValidos.get(estadoCivilTexto.toLocaleLowerCase('pt-BR'));
                if (!estadoCivil) {
                    throw new Error(`Campo estado_civil fora do padrão: "${estadoCivilTexto}". Use Solteiro, Noivo, Casado ou Amasiado.`);
                }
                const sexo = normalizarTextoOuNull(jovem.sexo, 20);
                if (sexo && !sexosValidos.has(sexo)) {
                    throw new Error(`Campo sexo fora do padrão: "${sexo}". Use Feminino ou Masculino.`);
                }
                const dataNascimento = normalizarDataPlanilha(jovem.data_nascimento);
                if (dataNascimento && !/^\d{4}-\d{2}-\d{2}$/.test(dataNascimento)) {
                    throw new Error(`Campo data_nascimento fora do padrão: "${jovem.data_nascimento}". Use AAAA-MM-DD.`);
                }
                const outroNumero = normalizarNumeroEjc(jovem.outro_ejc_numero);

                const telefoneHash = jovemPhoneHash(telefoneTexto);
                const cpfTexto = normalizarTextoOuNull(jovem.cpf, 30);
                if (cpfTexto) {
                    const digitos = cpfTexto.replace(/\D/g, '');
                    if (digitos.length !== 11) {
                        throw new Error(`Campo cpf fora do padrão: "${cpfTexto}". Use 11 dígitos.`);
                    }
                }
                const [exists] = await connection.query(
                    `SELECT id
                     FROM jovens
                     WHERE tenant_id = ?
                       AND origem_ejc_tipo = 'OUTRO_EJC'
                       AND outro_ejc_id = ?
                       AND (
                            nome_completo = ?
                         OR (? IS NOT NULL AND telefone_hash = ?)
                       )
                     LIMIT 1`,
                    [tenantId, outroEjc.id, nomeCompleto, telefoneHash, telefoneHash || '']
                );

                let jovemId = exists && exists[0] ? Number(exists[0].id) : 0;
                const dadosJovem = {
                    nome_completo: nomeCompleto,
                    telefone: encryptJovemPhone(telefoneTexto),
                    telefone_hash: telefoneHash,
                    origem_ejc_tipo: 'OUTRO_EJC',
                    outro_ejc_id: outroEjc.id,
                    outro_ejc_numero: outroNumero,
                    transferencia_outro_ejc: 0,
                    estado_civil: estadoCivil,
                    sexo: sexo || null,
                    data_nascimento: dataNascimento || null,
                    circulo: normalizarTextoOuNull(jovem.circulo, 80)
                };
                const apelido = normalizarTextoOuNull(jovem.apelido, 120);
                if (apelido) dadosJovem.apelido = apelido.toLocaleUpperCase('pt-BR');
                if (cpfTexto) {
                    dadosJovem.cpf = encryptJovemCpf(cpfTexto);
                    dadosJovem.cpf_hash = jovemCpfHash(cpfTexto);
                }

                if (jovemId) {
                    await connection.query('UPDATE jovens SET ? WHERE id = ? AND tenant_id = ?', [dadosJovem, jovemId, tenantId]);
                    atualizados += 1;
                } else {
                    const [insert] = await connection.query('INSERT INTO jovens SET ?', [{ tenant_id: tenantId, ...dadosJovem }]);
                    jovemId = Number(insert.insertId);
                    criados += 1;
                }

                const historico = Array.isArray(item.historico) ? item.historico : [];
                if (hasHistorico && historico.length) {
                    for (const hist of historico) {
                        const servico = parseServicoEquipe(hist.equipe);
                        if (!servico) continue;
                        const numeroHist = normalizarNumeroEjc(hist.numero_ejc || hist.edicao_ejc);
                        const ejcServico = numeroHist ? ejcsPorNumero.get(Number(numeroHist)) : null;
                        const edicaoTexto = numeroHist
                            ? `${numeroParaRomano(Number(numeroHist)) || numeroHist} EJC`
                            : normalizarTextoOuNull(hist.edicao_ejc, 180);

                        const papel = hist.papel || servico.papel || 'Membro';
                        const subfuncao = hist.subfuncao || servico.subfuncao || null;
                        const usarEjcId = !!(hasHistoricoEjcId && ejcServico && ejcServico.id);
                        if (!usarEjcId && (!hasHistoricoEdicao || !edicaoTexto)) continue;
                        const [histRows] = await connection.query(
                            hasHistoricoSubfuncao
                                ? `SELECT id FROM historico_equipes
                                   WHERE tenant_id = ? AND jovem_id = ? AND ${usarEjcId ? 'ejc_id = ?' : 'edicao_ejc = ?'} AND equipe = ? AND papel = ? AND (subfuncao <=> ?)
                                   LIMIT 1`
                                : `SELECT id FROM historico_equipes
                                   WHERE tenant_id = ? AND jovem_id = ? AND ${usarEjcId ? 'ejc_id = ?' : 'edicao_ejc = ?'} AND equipe = ? AND papel = ?
                                   LIMIT 1`,
                            hasHistoricoSubfuncao
                                ? [tenantId, jovemId, usarEjcId ? Number(ejcServico.id) : edicaoTexto, servico.equipe, papel, subfuncao]
                                : [tenantId, jovemId, usarEjcId ? Number(ejcServico.id) : edicaoTexto, servico.equipe, papel]
                        );
                        if (histRows && histRows.length) continue;

                        const insertHist = {
                            tenant_id: tenantId,
                            jovem_id: jovemId,
                            equipe: servico.equipe,
                            papel
                        };
                        if (hasHistoricoEjcId) insertHist.ejc_id = usarEjcId ? Number(ejcServico.id) : null;
                        if (hasHistoricoEdicao) insertHist.edicao_ejc = usarEjcId ? null : edicaoTexto;
                        if (hasHistoricoSubfuncao) insertHist.subfuncao = subfuncao;
                        if (hasHistoricoSnapshots.nome) insertHist.nome_completo_snapshot = nomeCompleto;
                        if (hasHistoricoSnapshots.telefone) insertHist.telefone_snapshot = telefoneTexto;
                        if (hasHistoricoSnapshots.origem) insertHist.origem_ejc_tipo_snapshot = 'OUTRO_EJC';
                        if (hasHistoricoSnapshots.outroNumero) insertHist.outro_ejc_numero_snapshot = outroNumero;
                        if (hasHistoricoSnapshots.outroId) insertHist.outro_ejc_id_snapshot = outroEjc.id;
                        if (hasHistoricoSnapshots.outroNome) insertHist.outro_ejc_nome_snapshot = outroEjc.nome || null;
                        if (hasHistoricoSnapshots.outroParoquia) insertHist.outro_ejc_paroquia_snapshot = outroEjc.paroquia || null;

                        await connection.query('INSERT INTO historico_equipes SET ?', [insertHist]);
                        historicos += 1;
                    }
                }
            } catch (err) {
                erros += 1;
                detalhesErros.push({
                    linha,
                    nome: nomeJovem,
                    erro: err && err.message ? err.message : 'Erro desconhecido durante importação.'
                });
            }
        }

        await connection.commit();
        return res.json({
            message: 'Importação concluída.',
            resumo: { criados, atualizados, historicos, erros },
            detalhesErros
        });
    } catch (error) {
        try { await connection.rollback(); } catch (_) { }
        console.error('Erro ao importar jovens de outros EJCs:', error);
        return res.status(500).json({ error: error && error.message ? error.message : 'Erro ao importar jovens.' });
    } finally {
        connection.release();
    }
});

router.get('/:id/observacoes', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'ID inválido.' });
    }

    try {
        const tenantId = getTenantId(req);
        await ensureObservacoesStructure();
        const [rows] = await db.pool.query(
            `SELECT id, observacao, created_at
             FROM outros_ejcs_observacoes_extras
             WHERE tenant_id = ? AND outro_ejc_id = ?
             ORDER BY created_at DESC, id DESC`,
            [tenantId, id]
        );
        return res.json(rows || []);
    } catch (error) {
        console.error('Erro ao listar observações extras do outro EJC:', error);
        return res.status(500).json({ error: 'Erro ao listar observações.' });
    }
});

router.post('/:id/observacoes', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'ID inválido.' });
    }

    try {
        const tenantId = getTenantId(req);
        await ensureObservacoesStructure();
        const observacao = String(req.body && req.body.observacao || '').trim();
        if (!observacao) {
            return res.status(400).json({ error: 'Informe a observação.' });
        }

        const [rows] = await db.pool.query(
            'SELECT id FROM outros_ejcs WHERE id = ? AND tenant_id = ? LIMIT 1',
            [id, tenantId]
        );
        if (!rows.length) {
            return res.status(404).json({ error: 'Outro EJC não encontrado.' });
        }

        const [result] = await db.pool.query(
            `INSERT INTO outros_ejcs_observacoes_extras (tenant_id, outro_ejc_id, observacao)
             VALUES (?, ?, ?)`,
            [tenantId, id, observacao]
        );
        return res.status(201).json({ id: result.insertId, message: 'Observação adicionada com sucesso.' });
    } catch (error) {
        console.error('Erro ao salvar observação extra do outro EJC:', error);
        return res.status(500).json({ error: 'Erro ao salvar observação.' });
    }
});

// POST /api/outros-ejcs
router.post('/', async (req, res) => {
    const { nome, paroquia, bairro, observacoes } = req.body;
    try {
        const tenantId = getTenantId(req);
        await ensureObservacoesStructure();
        if (!nome) {
            return res.status(400).json({ error: 'O nome do EJC é obrigatório.' });
        }
        const paroquiaValue = String(paroquia || '').trim();
        const bairroValue = String(bairro || '').trim();
        const [result] = await db.pool.query(
            'INSERT INTO outros_ejcs (tenant_id, nome, paroquia, bairro, observacoes) VALUES (?, ?, ?, ?, ?)',
            [tenantId, String(nome).trim(), paroquiaValue, bairroValue, String(observacoes || '').trim() || null]
        );
        res.status(201).json({ message: 'Outro EJC criado com sucesso!', id: result.insertId });
    } catch (error) {
        console.error("Erro ao criar outro EJC:", error);
        res.status(500).json({ error: 'Erro ao criar outro EJC' });
    }
});

// PUT /api/outros-ejcs/:id
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { nome, paroquia, bairro, observacoes } = req.body;
    try {
        const tenantId = getTenantId(req);
        await ensureObservacoesStructure();
        if (!nome) {
            return res.status(400).json({ error: 'O nome do EJC é obrigatório.' });
        }
        const paroquiaValue = String(paroquia || '').trim();
        const bairroValue = String(bairro || '').trim();
        const [result] = await db.pool.query(
            'UPDATE outros_ejcs SET nome = ?, paroquia = ?, bairro = ?, observacoes = ? WHERE id = ? AND tenant_id = ?',
            [String(nome).trim(), paroquiaValue, bairroValue, String(observacoes || '').trim() || null, id, tenantId]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Outro EJC não encontrado.' });
        }
        res.json({ message: 'Outro EJC atualizado com sucesso!' });
    } catch (error) {
        console.error("Erro ao atualizar outro EJC:", error);
        res.status(500).json({ error: 'Erro ao atualizar outro EJC' });
    }
});

// DELETE /api/outros-ejcs/:id
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const tenantId = getTenantId(req);
        const outroId = Number(id);
        if (!Number.isInteger(outroId) || outroId <= 0) {
            return res.status(400).json({ error: 'ID inválido.' });
        }

        const bloqueios = [];

        if (await hasTable('garcons_equipes')) {
            const hasCol = await hasColumn('garcons_equipes', 'outro_ejc_id');
            if (hasCol) {
                const [[row]] = await db.pool.query(
                    'SELECT COUNT(*) AS total FROM garcons_equipes WHERE outro_ejc_id = ?',
                    [outroId]
                );
                const total = Number(row && row.total || 0);
                if (total > 0) bloqueios.push(`Garçons (${total})`);
            }
        }

        if (await hasTable('jovens')) {
            const hasCol = await hasColumn('jovens', 'outro_ejc_id');
            if (hasCol) {
                const [[row]] = await db.pool.query(
                    'SELECT COUNT(*) AS total FROM jovens WHERE outro_ejc_id = ? AND tenant_id = ?',
                    [outroId, tenantId]
                );
                const total = Number(row && row.total || 0);
                if (total > 0) bloqueios.push(`Jovens de outro EJC (${total})`);
            }
        }

        if (await hasTable('formularios_presencas')) {
            const hasCol = await hasColumn('formularios_presencas', 'outro_ejc_id');
            if (hasCol) {
                const [[row]] = await db.pool.query(
                    'SELECT COUNT(*) AS total FROM formularios_presencas WHERE outro_ejc_id = ? AND tenant_id = ?',
                    [outroId, tenantId]
                );
                const total = Number(row && row.total || 0);
                if (total > 0) bloqueios.push(`Presenças (${total})`);
            }
        }

        if (bloqueios.length) {
            return res.status(409).json({
                error: `Não é possível excluir este EJC. Existem vínculos em: ${bloqueios.join(', ')}. Remova esses vínculos antes de excluir.`
            });
        }

        const [result] = await db.pool.query('DELETE FROM outros_ejcs WHERE id = ? AND tenant_id = ?', [id, tenantId]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Outro EJC não encontrado.' });
        }
        res.json({ message: 'Outro EJC excluído com sucesso!' });
    } catch (error) {
        console.error("Erro ao excluir outro EJC:", error);
        res.status(500).json({ error: 'Erro ao excluir outro EJC' });
    }
});

module.exports = router;
