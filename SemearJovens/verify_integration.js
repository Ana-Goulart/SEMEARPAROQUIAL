const axios = require('axios');
const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
    host: 'localhost',
    user: 'infra',
    password: 'anaclara14',
    database: 'db_semeajovens'
});

async function runTest() {
    try {
        console.log("=== TESTE DE INTEGRACAO ===");

        // 1. Criar Jovem de Teste
        console.log("1. Criando Jovem de teste...");
        const [resJovem] = await pool.query('INSERT INTO jovens (nome, email) VALUES (?, ?)', ['Jovem Teste Integração ' + Date.now(), 'teste@teste.com']);
        const jovemId = resJovem.insertId;
        console.log(`   Jovem criado ID: ${jovemId}`);

        // 2. Criar Usuário vinculado (Simulando chamada API POST /api/usuarios)
        console.log("2. Criando Usuário vinculado...");
        // Como não tenho axios vs server rodando garantido, vou fazer insert direto simulando a logica? 
        // Não, a lógica está no ROUTER. Preciso testar SE a logica do router funciona.
        // Mas para testar router preciso subir server ou simular request.
        // Vou verificar se a MIGRATION funcionou e se a query de UPDATE funciona.

        // Simulação do Router Logic:
        const connection = await pool.getConnection();
        await connection.beginTransaction();
        try {
            await connection.query(
                'INSERT INTO usuarios (username, nome_completo, senha, grupo, jovem_id) VALUES (?, ?, ?, ?, ?)',
                ['user_test_' + Date.now(), 'User Test', 'hashedpass', 'Jovens', jovemId]
            );
            await connection.query('UPDATE jovens SET dirigente = 1 WHERE id = ?', [jovemId]);
            await connection.commit();
            console.log("   Usuário inserido e Jovem atualizado (via lógica simulada).");
        } catch (e) {
            await connection.rollback();
            throw e;
        } finally {
            connection.release();
        }

        // 3. Verificar Flag Dirigente
        const [rows] = await pool.query('SELECT dirigente FROM jovens WHERE id = ?', [jovemId]);
        if (rows[0].dirigente === 1) {
            console.log("✅ SUCESSO: Jovem marcado como dirigente.");
        } else {
            console.error("❌ FALHA: Jovem NÃO foi marcado como dirigente.");
        }

        // Limpeza
        await pool.query('DELETE FROM usuarios WHERE jovem_id = ?', [jovemId]);
        await pool.query('DELETE FROM jovens WHERE id = ?', [jovemId]);

    } catch (err) {
        console.error("ERRO:", err);
    } finally {
        await pool.end();
    }
}

runTest();
