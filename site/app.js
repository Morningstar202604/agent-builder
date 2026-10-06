// agent-builder — Official Site JS

document.addEventListener('DOMContentLoaded', () => {
    // Intersection Observer for scroll animations
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.style.opacity = '1';
                entry.target.style.transform = 'translateY(0)';
            }
        });
    }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });

    // Apply to node cards and feature cards
    const animateEls = document.querySelectorAll('.node-card, .feature-card, .stack-layer');
    animateEls.forEach((el, i) => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(20px)';
        el.style.transition = `opacity 0.4s ease ${i * 0.05}s, transform 0.4s ease ${i * 0.05}s`;
        observer.observe(el);
    });

    // Smooth reveal for compare table
    const compareTable = document.querySelector('.compare-table-wrap');
    if (compareTable) {
        compareTable.style.opacity = '0';
        compareTable.style.transform = 'translateY(30px)';
        compareTable.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
        observer.observe(compareTable);
    }

    // Header scroll effect
    let lastScroll = 0;
    const header = document.querySelector('.header');
    window.addEventListener('scroll', () => {
        const currentScroll = window.pageYOffset;
        if (currentScroll > 100) {
            header.style.borderBottomColor = 'rgba(0, 255, 136, 0.1)';
        } else {
            header.style.borderBottomColor = '';
        }
        lastScroll = currentScroll;
    }, { passive: true });

    // Animated counter for stats
    const statNums = document.querySelectorAll('.stat-num');
    const statsObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                animateValue(entry.target);
                statsObserver.unobserve(entry.target);
            }
        });
    }, { threshold: 0.5 });

    statNums.forEach(el => statsObserver.observe(el));

    function animateValue(el) {
        const text = el.textContent;
        const num = parseInt(text);
        if (isNaN(num)) return;
        let current = 0;
        const step = Math.max(1, Math.floor(num / 30));
        const interval = setInterval(() => {
            current += step;
            if (current >= num) {
                current = num;
                clearInterval(interval);
            }
            el.textContent = current;
        }, 40);
    }
});
