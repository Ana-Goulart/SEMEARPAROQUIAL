(function () {
    const modalId = 'semearTermosUsoLgpdModal';
    const styleId = 'semearTermosUsoLgpdStyle';

    function ensureStyle() {
        if (document.getElementById(styleId)) return;
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            .semear-termos-backdrop {
                position: fixed;
                inset: 0;
                z-index: 2000;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 16px;
                background: rgba(23, 32, 51, 0.58);
            }
            .semear-termos-dialog {
                width: min(820px, 100%);
                max-height: min(86vh, 760px);
                display: flex;
                flex-direction: column;
                border-radius: 10px;
                background: #fffdf8;
                box-shadow: 0 24px 70px rgba(23, 32, 51, 0.28);
                overflow: hidden;
            }
            .semear-termos-header,
            .semear-termos-footer {
                flex: 0 0 auto;
                padding: 16px 18px;
                border-color: rgba(34, 55, 80, 0.12);
            }
            .semear-termos-header {
                display: flex;
                align-items: flex-start;
                justify-content: space-between;
                gap: 12px;
                border-bottom: 1px solid rgba(34, 55, 80, 0.12);
            }
            .semear-termos-title {
                margin: 0;
                color: #172033;
                font-size: 1.05rem;
                font-weight: 700;
            }
            .semear-termos-body {
                overflow-y: auto;
                padding: 18px;
                color: #172033;
                line-height: 1.55;
            }
            .semear-termos-body h3 {
                margin: 1rem 0 .4rem;
                color: #223750;
                font-size: 1rem;
                font-weight: 700;
            }
            .semear-termos-body p {
                margin-bottom: .75rem;
            }
            .semear-termos-footer {
                display: flex;
                justify-content: flex-end;
                border-top: 1px solid rgba(34, 55, 80, 0.12);
                background: #f7f2e8;
            }
            .semear-termos-close {
                border: 1px solid rgba(34, 55, 80, 0.24);
                border-radius: 8px;
                padding: 8px 14px;
                background: #223750;
                color: #fff;
                font-weight: 600;
            }
            .form-check-input:checked {
                background-color: #c99a3d;
                border-color: #c99a3d;
            }
            .form-check-input:focus {
                border-color: #c99a3d;
                box-shadow: 0 0 0 .2rem rgba(201, 154, 61, .22);
            }
        `;
        document.head.appendChild(style);
    }

    function closeModal() {
        const modal = document.getElementById(modalId);
        if (modal) modal.remove();
    }

    function openModal() {
        ensureStyle();
        closeModal();

        const modal = document.createElement('div');
        modal.id = modalId;
        modal.className = 'semear-termos-backdrop';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.innerHTML = `
            <div class="semear-termos-dialog">
                <div class="semear-termos-header">
                    <h2 class="semear-termos-title">Termos de Uso e Política de Privacidade</h2>
                    <button type="button" class="btn-close" aria-label="Fechar" data-semear-termos-close></button>
                </div>
                <div class="semear-termos-body">
                    <p><strong>TERMO DE CONSENTIMENTO E PRIVACIDADE - SEMEAR PAROQUIAL</strong></p>
                    <p>Ao clicar em "Li e concordo", você autoriza a plataforma Semear Paroquial e a Coordenação do EJC da sua Paróquia a realizarem o tratamento dos seus dados pessoais para fins estritamente organizacionais e pastorais.</p>

                    <h3>1. Quais dados coletamos e para quê?</h3>
                    <p>Para garantir a sua segurança, organização das equipes e bom andamento dos encontros e eventos do EJC, coletamos:</p>
                    <p><strong>Dados de Identificação e Contato:</strong> Nome completo, apelido, e-mail, telefone, data de nascimento, CPF, sexo, endereço, foto e Instagram - Esses dados servem para a Secretaria emitir crachás, listas de presença e manter contato com você.</p>
                    <p><strong>Dados de Saúde e Restrições:</strong> Informações sobre alergias, restrições alimentares, tipo de deficiência (PCD) ou formação na área de saúde - Dados fundamentais para que a equipe de Cozinha, Saúde e Apoio saiba como cuidar de você em caso de emergência.</p>
                    <p><strong>Histórico Pastoral:</strong> Suas habilidades musicais, pastorais que participa e funções que já exerceu em EJCs anteriores - Usado exclusivamente para ajudar a dirigência a entender o seu perfil paroquial.</p>

                    <h3>2. Quem tem acesso aos seus dados?</h3>
                    <p>Os seus dados são armazenados de forma segura em ambiente digital e são de uso único, exclusivo e restrito da Dirigência e Coordenação Geral do EJC da sua paróquia.</p>
                    <p><strong>Compromisso de Sigilo:</strong> Em hipótese alguma os seus dados cadastrais, fotos ou documentos serão vendidos, divulgados, compartilhados com empresas ou utilizados para fins comerciais.</p>

                    <h3>3. Direitos do Jovem (LGPD)</h3>
                    <p>Você, como dono dos seus dados, tem o direito de solicitar a correção de informações desatualizadas, o bloqueio ou a exclusão definitiva do seu cadastro da base de dados do sistema a qualquer momento, bastando entrar em contato direto com a Dirigência do EJC.</p>

                    <h3>4. Consentimento Obrigatório</h3>
                    <p>Ao marcar a caixa de seleção abaixo e enviar este formulário, você declara ser maior de 18 anos (ou estar preenchendo com a autorização de seus pais/responsáveis) e manifesta seu consentimento livre, informado e inequívoco para o tratamento dos seus dados conforme descrito neste termo.</p>
                </div>
                <div class="semear-termos-footer">
                    <button type="button" class="semear-termos-close" data-semear-termos-close>Fechar</button>
                </div>
            </div>
        `;
        modal.addEventListener('click', (event) => {
            if (event.target === modal || event.target.closest('[data-semear-termos-close]')) closeModal();
        });
        document.body.appendChild(modal);
    }

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeModal();
    });

    window.abrirTermosUsoSemear = openModal;
})();
