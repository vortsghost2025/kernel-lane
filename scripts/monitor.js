#!/usr/bin/env node
/**
 * monitor.js - Phase 4.2 CLI Dashboard
 *
 * Usage:
 *   node scripts/monitor.js --live        # Continuous dashboard with refresh
 *   node scripts/monitor.js --once        # One-time snapshot
 *   node scripts/monitor.js --alerts      # Show active alerts
 *   node scripts/monitor.js --config      # Show current thresholds
 */

const path = require('path');
const { MetricsCollector } = require('../src/monitoring/MetricsCollector');
const { AlertEngine, DEFAULT_THRESHOLDS } = require('../src/monitoring/AlertEngine');
const { Notifier } = require('../src/monitoring/Notifier');

function parseArgs() {
	const args = process.argv.slice(2);
	return {
		live: args.includes('--live'),
		once: args.includes('--once'),
		alerts: args.includes('--alerts'),
		config: args.includes('--config'),
		help: args.includes('--help') || args.includes('-h')
	};
}

function printHelp() {
	console.log(`
Archivist Monitor (Phase 4.2)

Usage:
  node scripts/monitor.js --live        Continuous dashboard with refresh
  node scripts/monitor.js --once        One-time snapshot
  node scripts/monitor.js --alerts      Show active alerts
  node scripts/monitor.js --config      Show current thresholds

Environment:
  QUEUE_DIR    Override queue directory path
`);
}

function formatMetrics(metrics) {
	const lines = [];
	lines.push('╔══════════════════════════════════════════════════════════════╗');
	lines.push('║              ARCHIVIST MONITORING DASHBOARD                  ║');
	lines.push('╠══════════════════════════════════════════════════════════════╣');
	lines.push(`║ Timestamp: ${metrics.timestamp.padEnd(47)}║`);
	lines.push('╠══════════════════════════════════════════════════════════════╣');
	lines.push('║ QUEUE STATUS                                                 ║');
	lines.push('╠══════════════════════════════════════════════════════════════╣');
	lines.push(`║   Incident Pending:    ${String(metrics.queue.incident_pending).padStart(5)}                              ║`);
	lines.push(`║   Incident Escalated:  ${String(metrics.queue.incident_escalated).padStart(5)}                              ║`);
	lines.push(`║   Auto-Resolved:       ${String(metrics.queue.incident_auto_resolved).padStart(5)}                              ║`);
	lines.push(`║   Approval Pending:    ${String(metrics.queue.approval_pending).padStart(5)}                              ║`);
	lines.push('╠══════════════════════════════════════════════════════════════╣');
	lines.push('║ SEVERITY DISTRIBUTION                                        ║');
	lines.push('╠══════════════════════════════════════════════════════════════╣');
	lines.push(`║   P0 (CRITICAL): ${String(metrics.severity.P0).padStart(3)}    P1 (HIGH): ${String(metrics.severity.P1).padStart(3)}    P2 (MEDIUM): ${String(metrics.severity.P2).padStart(3)}    P3 (LOW): ${String(metrics.severity.P3).padStart(3)}     ║`);
	lines.push('╠══════════════════════════════════════════════════════════════╣');
	lines.push('║ RATES (per hour)                                             ║');
	lines.push('╠══════════════════════════════════════════════════════════════╣');
	lines.push(`║   Quarantine:     ${metrics.rates.quarantine_per_hour.toFixed(2).padStart(6)}                                   ║`);
	lines.push(`║   Escalation:     ${metrics.rates.escalation_per_hour.toFixed(2).padStart(6)}                                   ║`);
	lines.push(`║   Auto-Resolve:   ${metrics.rates.auto_resolve_per_hour.toFixed(2).padStart(6)}                                   ║`);
	lines.push(`║   Total Incidents: ${metrics.rates.incidents_per_hour.toFixed(2).padStart(5)}                                   ║`);
	lines.push('╚══════════════════════════════════════════════════════════════╝');
	return lines.join('\n');
}

function formatAlerts(activeAlerts) {
	if (activeAlerts.length === 0) {
		return 'No active alerts.';
	}

	const lines = [];
	lines.push('╔══════════════════════════════════════════════════════════════╗');
	lines.push('║                    ACTIVE ALERTS                             ║');
	lines.push('╠══════════════════════════════════════════════════════════════╣');

	for (const alert of activeAlerts) {
		const sevColor = alert.severity === 'CRITICAL' ? '🔴' : alert.severity === 'HIGH' ? '🟠' : '🟡';
		lines.push(`║ ${sevColor} [${alert.severity.padEnd(8)}] ${alert.type.padEnd(25)} ║`);
		lines.push(`║   ${alert.message.substring(0, 54).padEnd(54)}║`);
		lines.push(`║   ID: ${alert.id.padEnd(54)}║`);
		lines.push('╠══════════════════════════════════════════════════════════════╣');
	}

	lines.push('╚══════════════════════════════════════════════════════════════╝');
	return lines.join('\n');
}

function formatConfig() {
	const lines = [];
	lines.push('╔══════════════════════════════════════════════════════════════╗');
	lines.push('║                 ALERT THRESHOLDS                             ║');
	lines.push('╠══════════════════════════════════════════════════════════════╣');

	for (const [name, config] of Object.entries(DEFAULT_THRESHOLDS)) {
		lines.push(`║ ${name.padEnd(20)} > ${String(config.value).padStart(5)}  [${config.severity.padEnd(8)}]      ║`);
	}

	lines.push('╚══════════════════════════════════════════════════════════════╝');
	return lines.join('\n');
}

async function main() {
	const opts = parseArgs();

	if (opts.help) {
		printHelp();
		process.exit(0);
	}

	const collector = new MetricsCollector();
	const engine = new AlertEngine();
	const notifier = new Notifier();

	if (opts.config) {
		console.log(formatConfig());
		process.exit(0);
	}

	if (opts.alerts) {
		engine._loadAlerts();
		const active = engine.getActiveAlerts();
		console.log(formatAlerts(active));
		process.exit(0);
	}

	if (opts.once) {
		const metrics = collector.collect();
		console.log(formatMetrics(metrics));

		const triggered = engine.check(metrics);
		if (triggered.length > 0) {
			console.log('\n⚠️  Alerts triggered:');
			for (const alert of triggered) {
				console.log(`  [${alert.severity}] ${alert.message}`);
				await notifier.send(alert);
			}
		}

		const stats = engine.getStats();
		console.log(`\nAlert Stats: ${stats.active} active, ${stats.acknowledged} acknowledged, ${stats.resolved} resolved`);
		process.exit(0);
	}

	if (opts.live) {
		console.log('Starting live monitor (Ctrl+C to stop)...\n');

		const refresh = async () => {
			process.stdout.write('\x1b[2J\x1b[H');
			const metrics = collector.collect();
			console.log(formatMetrics(metrics));

			const triggered = engine.check(metrics);
			if (triggered.length > 0) {
				console.log('\n⚠️  New alerts:');
				for (const alert of triggered) {
					console.log(`  [${alert.severity}] ${alert.message}`);
					await notifier.send(alert);
				}
			}

			const stats = engine.getStats();
			console.log(`\nAlert Stats: ${stats.active} active | ${stats.acknowledged} acknowledged | ${stats.resolved} resolved`);
			console.log(`\nLast update: ${new Date().toISOString()}`);
		};

		await refresh();
		setInterval(refresh, 10000);

		process.on('SIGINT', () => {
			console.log('\nStopping monitor...');
			process.exit(0);
		});

		return;
	}

	printHelp();
	process.exit(1);
}

main().catch(err => {
	console.error('Error:', err.message);
	process.exit(1);
});
