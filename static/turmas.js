(function() {
    'use strict';

    const evaluatorName = window.TURMAS_CONFIG?.evaluatorName || '';
    let activeEvaluationTurmas = window.TURMAS_CONFIG?.activeEvaluationTurmas || [];
    const csrfToken = window.TURMAS_CONFIG?.csrfToken || '';
    const evaluationModal = document.getElementById('evaluationModal');
    const evaluationPinInput = document.getElementById('evaluationPinInput');
    const evaluationModalTurmaName = document.getElementById('evaluationModalTurmaName');
    const evaluationTurmaList = document.getElementById('evaluationTurmaList');
    const globalEvaluationButton = document.getElementById('globalEvaluationButton');
    const btnEvaluationCancel = document.getElementById('btnEvaluationCancel');
    const btnEvaluationConfirm = document.getElementById('btnEvaluationConfirm');

    let selectedTurmaId = null;
    let selectedTurmaName = '';

    function clearErrors() {
        document.querySelectorAll('.modal-error').forEach(error => error.remove());
        if (evaluationPinInput) evaluationPinInput.classList.remove('error');
    }

    function showError(message) {
        const input = evaluationPinInput;
        if (!input) return;

        input.classList.add('error');
        input.value = '';

        const previous = input.parentNode.querySelector('.modal-error');
        if (previous) previous.remove();

        const errorMessage = document.createElement('div');
        errorMessage.className = 'modal-error';
        errorMessage.textContent = message || 'Acesso inválido.';
        input.parentNode.insertBefore(errorMessage, input);

        setTimeout(() => {
            input.classList.remove('error');
            input.focus();
        }, 2000);
    }

    function selectEvaluationTurma(turma) {
        selectedTurmaId = turma.id;
        selectedTurmaName = turma.name;

        evaluationModalTurmaName.textContent = `Turma avaliada: ${selectedTurmaName}`;

        evaluationTurmaList.querySelectorAll('.evaluation-turma-option').forEach(button => {
            button.classList.toggle('is-selected', button.dataset.turmaId === String(turma.id));
            button.setAttribute('aria-pressed', button.dataset.turmaId === String(turma.id) ? 'true' : 'false');
        });
    }

    function renderEvaluationTurmas() {
        evaluationTurmaList.innerHTML = '';

        if (activeEvaluationTurmas.length <= 1) {
            evaluationTurmaList.hidden = true;
            return;
        }

        evaluationTurmaList.hidden = false;
        activeEvaluationTurmas.forEach(turma => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'evaluation-turma-option';
            button.dataset.turmaId = turma.id;
            button.setAttribute('aria-pressed', 'false');

            const name = document.createElement('strong');
            name.textContent = turma.name;

            const teacher = document.createElement('span');
            teacher.textContent = `Responsável: ${turma.teacher_name || 'Não definido'}`;

            button.append(name, teacher);
            button.addEventListener('click', () => selectEvaluationTurma(turma));
            evaluationTurmaList.appendChild(button);
        });
    }

    function openEvaluationModal() {
        if (activeEvaluationTurmas.length === 0) return;

        selectedTurmaId = null;
        selectedTurmaName = '';
        renderEvaluationTurmas();
        clearErrors();
        evaluationPinInput.value = '';
        evaluationModal.classList.add('active');

        if (activeEvaluationTurmas.length === 1) {
            selectEvaluationTurma(activeEvaluationTurmas[0]);
            setTimeout(() => evaluationPinInput.focus(), 150);
            return;
        }

        evaluationModalTurmaName.textContent = 'Selecione a turma liberada pelo admin e informe o PIN.';
        setTimeout(() => evaluationTurmaList.querySelector('button')?.focus(), 150);
    }

    function closeModal() {
        if (evaluationModal) evaluationModal.classList.remove('active');
        selectedTurmaId = null;
        selectedTurmaName = '';
    }

    function goToRoom(turmaId) {
        if (!turmaId || !evaluatorName) return;
        window.location.href = `/turmas/${encodeURIComponent(evaluatorName)}/${turmaId}`;
    }

    async function enterEvaluation() {
        const code = evaluationPinInput.value.trim();

        if (!selectedTurmaId) {
            showError('Selecione uma turma liberada para avaliação.');
            return;
        }

        if (code.length !== 4 || !/^\d+$/.test(code)) {
            showError('Digite o PIN com 4 dígitos.');
            return;
        }

        try {
            const response = await fetch('/turmas/evaluate-access', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
                body: JSON.stringify({
                    evaluatorName,
                    turmaId: selectedTurmaId,
                    code,
                }),
            });

            const data = await response.json();
            if (data.success) {
                window.location.href = data.redirectUrl;
                return;
            }

            showError(data.message || 'PIN inválido ou expirado.');
        } catch (error) {
            console.error('Erro ao verificar PIN:', error);
            showError('Erro de conexão com o servidor. Tente novamente.');
        }
    }

    document.querySelectorAll('.turma-card[data-action="room"]').forEach(card => {
        card.addEventListener('click', () => {
            goToRoom(card.dataset.turmaId);
        });

        card.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                goToRoom(card.dataset.turmaId);
            }
        });
    });

    globalEvaluationButton?.addEventListener('click', openEvaluationModal);
    btnEvaluationCancel?.addEventListener('click', closeModal);
    btnEvaluationConfirm?.addEventListener('click', enterEvaluation);

    evaluationPinInput?.addEventListener('keypress', event => {
        if (event.key === 'Enter') enterEvaluation();
    });

    evaluationModal?.addEventListener('click', event => {
        if (event.target === evaluationModal) closeModal();
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeModal();
    });

    // Escuta eventos SSE customizados para atualizar lista de turmas abertas
    window.addEventListener('sse:session_started', (e) => {
        try {
            const payload = e.detail || {};
            const tid = Number(payload.turmaId);
            if (!tid) return;
            if (!activeEvaluationTurmas.some(t => Number(t.id) === tid)) {
                // tenta ler nome/responsável a partir do card DOM
                const card = document.querySelector(`.turma-card[data-turma-id="${tid}"]`);
                const name = card ? card.dataset.turmaName : `Turma ${tid}`;
                const teacherP = card ? card.querySelector('p') : null;
                const teacher_text = teacherP ? (teacherP.textContent.replace('Responsável: ', '') || '') : '';
                activeEvaluationTurmas.push({ id: tid, name, teacher_name: teacher_text });
            }
        } catch (err) { console.error('sse:start handler', err); }
    });

    window.addEventListener('sse:session_closed', (e) => {
        try {
            const payload = e.detail || {};
            const tid = Number(payload.turmaId);
            if (!tid) return;
            activeEvaluationTurmas = activeEvaluationTurmas.filter(t => Number(t.id) !== tid);
        } catch (err) { console.error('sse:close handler', err); }
    });

    window.addEventListener('sse:session_ended', (e) => {
        try {
            activeEvaluationTurmas = [];
        } catch (err) { console.error('sse:ended handler', err); }
    });
})();
