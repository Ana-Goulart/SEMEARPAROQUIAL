const { pool } = require('../database');

async function purgeExpiredUsers() {
    try {
        // Se data_saida foi ontem ou antes, hoje o usuário já não deve existir.
        const [result] = await pool.query(`
            DELETE FROM usuarios
            WHERE data_saida IS NOT NULL
              AND DATE(data_saida) < CURDATE()
        `);
        return Number(result && result.affectedRows ? result.affectedRows : 0);
    } catch (err) {
        console.error('Erro ao limpar usuários expirados:', err);
        return 0;
    }
}

module.exports = { purgeExpiredUsers };
