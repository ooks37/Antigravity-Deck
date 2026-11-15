// === Permission Routes ===
// /api/permissions GET, POST, PUT, POST /api/permissions/preset

const { z } = require('zod');
const permissionManager = require('../permission-manager');

const RuleListSchema = z.array(z.string().max(500)).max(200);

const PermissionsUpdateSchema = z.object({
    autoAccept: z.boolean().optional(),
    autoAcceptPolicy: z.enum(['smart', 'full']).optional(),
    cli: z.object({
        agentMode: z.enum(['', 'default', 'accept-edits', 'auto', 'plan']).optional(),
        toolPermission: z.enum(['request-review', 'proceed-in-sandbox', 'always-proceed', 'strict']).optional(),
        artifactReviewPolicy: z.enum(['asks-for-review', 'agent-decides', 'always-proceed']).optional(),
        allowNonWorkspaceAccess: z.boolean().optional(),
        enableTerminalSandbox: z.boolean().optional(),
        permissions: z.object({
            allow: RuleListSchema.optional(),
            ask: RuleListSchema.optional(),
            deny: RuleListSchema.optional(),
        }).strict().optional(),
    }).strict().optional(),
}).strict();

const PresetSchema = z.object({
    preset: z.enum(['strict', 'default', 'accept-edits', 'auto', 'turbo']),
}).strict();

module.exports = function setupPermissionRoutes(app) {
    app.get('/api/permissions', (req, res) => {
        const { lsConfig } = require('../config');
        res.json({
            ...permissionManager.getState(),
            lsConnected: Boolean(lsConfig.detected),
        });
    });

    const handleUpdate = (req, res) => {
        try {
            const validated = PermissionsUpdateSchema.parse(req.body || {});
            const updated = permissionManager.updatePermissions(validated);
            const { lsConfig } = require('../config');
            res.json({
                ...updated,
                lsConnected: Boolean(lsConfig.detected),
            });
        } catch (error) {
            if (error instanceof z.ZodError) {
                return res.status(400).json({ error: '权限配置参数无效', details: error.issues });
            }
            return res.status(400).json({ error: error.message || '更新权限配置失败' });
        }
    };

    app.post('/api/permissions', handleUpdate);
    app.put('/api/permissions', handleUpdate);

    app.post('/api/permissions/preset', (req, res) => {
        try {
            const { preset } = PresetSchema.parse(req.body || {});
            const updated = permissionManager.applyPreset(preset);
            const { lsConfig } = require('../config');
            res.json({
                ...updated,
                presetApplied: preset,
                lsConnected: Boolean(lsConfig.detected),
            });
        } catch (error) {
            if (error instanceof z.ZodError) {
                return res.status(400).json({ error: '无效的权限预设名', details: error.issues });
            }
            return res.status(400).json({ error: error.message || '应用权限预设失败' });
        }
    });
};
