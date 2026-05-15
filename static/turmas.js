(async function() {
    'use strict';

    // Elementos
    const modal = document.getElementById('codeModal');
    const pinInput = document.getElementById('pinInput');
    const modalTurmaName = document.getElementById('modalTurmaName');
    const btnCancel = document.getElementById('btnCancel');
    const btnConfirm = document.getElementById('btnConfirm');
    const turmaCards = document.querySelectorAll('.turma-card');

    // Estado
    let selectedTurmaId = null;
    const evaluatorName = window.TURMAS_CONFIG?.evaluatorName || '';

    // ===== Funções =====

    function openModal(id, name) {
        selectedTurmaId = id;
        modalTurmaName.textContent = `Turma: ${name}`;
        modal.classList.add('active');
        pinInput.value = '';
        pinInput.classList.remove('error');
        
        // Foco automático com pequeno delay para animação
        setTimeout(() => pinInput.focus(), 150);
    }

    function closeModal() {
        modal.classList.remove('active');
        selectedTurmaId = null;
    }

    function showError(message) {
        pinInput.classList.add('error');
        pinInput.value = '';

        //Mostra mensagem de erro temporária
        const erroMsg = document.createElement('div');
        erroMsg.style.color = 'color: #b91c1c; font-size: 0.9rem; margin-bottom: 12px;';
        erroMsg.textContent = message || 'Código inválido';
        pinInput.parentNode.insertBefore(erroMsg, pinInput);

        setTimeout(() => {
            pinInput.classList.remove('error');
            pinInput.focus();
        }, 2000);
    }

    async function verifyCode() {
        const password = pinInput.value.trim();
        
        // Validação básica
        if (!selectedTurmaId) {
            alert('Selecione uma turma primeiro.');
            return;
        }

        if (!password) {
            showError('Digite a senha da turma.');
            return;
        }

        try {
            const response = await fetch('/turmas/access', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    evaluatorName,
                    turmaId: selectedTurmaId, 
                    password 
                })
            });

            const data = await response.json();

            if (data.success) {
                if (!evaluatorName) {
                    alert('Erro: Nome do avaliador não encontrado');
                    return;
                }

                window.location.href = data.redirectUrl;
            } else {
                showError(data.message || 'Senha da turma inválida.');
            }
        } catch (error) {
            console.error('Erro ao verificar código:', error);
            showError('Erro de conexão com o servidor. Tente novamente.');
        }
    }

    // ===== Event Listeners =====

    // Clique nos cards de turma
    turmaCards.forEach(card => {
        card.addEventListener('click', () => {
            const id = card.dataset.turmaId;
            const name = card.dataset.turmaName;
            openModal(id, name);
        });
    });

    // Botões do modal
    btnCancel.addEventListener('click', closeModal);
    btnConfirm.addEventListener('click', verifyCode);

    // Tecla Enter no input
    pinInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            verifyCode();
        }
    });

    // Fechar modal clicando fora
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeModal();
        }
    });

    // Fechar com ESC
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('active')) {
            closeModal();
        }
    });

})();
