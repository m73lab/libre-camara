const op = (service, method, path, shape, params = [], ttl = 300, extra = {}) => ({
  service,
  method,
  path,
  shape,
  params,
  ttl,
  ...extra,
});

const q = (key, upstream, type, required = true) => ({ from: 'query', key, upstream, type, required });
const p = (key, upstream, type, required = true) => ({ from: 'params', key, upstream, type, required });

const TIPO_METODOS = {
  'asistencia': 'retornarTiposAsistencia',
  'camara-origen': 'retornarTiposCamaraOrigen',
  'estado': 'retornarTiposEstado',
  'estado-acuerdos-resoluciones': 'retornarTiposEstadoAcuerdosResoluciones',
  'estado-sesion-comision': 'retornarTiposEstadoSesionComision',
  'estado-sesion-sala': 'retornarTiposEstadoSesionSala',
  'iniciativa-proyecto-ley': 'retornarTiposIniciativaProyectoLey',
  'justificaciones-inasistencia': 'retornarTiposJustificacionesInasistencia',
  'legislatura': 'retornarTiposLegislatura',
  'opcion-voto': 'retornarTiposOpcionVoto',
  'quorum-votacion': 'retornarTiposQuorumVotacion',
  'resultado-votacion': 'retornarTiposResultadoVotacion',
  'sesion-comision': 'retornarTiposSesionComision',
  'sesion-sala': 'retornarTiposSesionSala',
  'sexo': 'retornarTiposSexo',
  'titular-asistencia': 'retornarTiposTitularAsistencia',
  'votacion': 'retornarTiposVotacion',
  'votacion-proyecto-ley': 'retornarTiposVotacionProyectoLey',
};

export const catalog = [
  op('WSLegislativo', 'retornarPeriodosLegislativos', '/periodos-legislativos', 'collection', [], 3600),
  op('WSLegislativo', 'retornarPeriodoLegislativoActual', '/periodo-actual', 'single', [], 600),
  op('WSLegislativo', 'retornarLegislaturas', '/legislaturas', 'collection', [], 3600),
  op('WSLegislativo', 'retornarLegislaturaActual', '/legislatura-actual', 'single', [], 600),
  op('WSLegislativo', 'retornarMaterias', '/materias', 'collection', [], 3600),
  op('WSLegislativo', 'retornarMensajesXAnno', '/mensajes', 'collection', [q('anno', 'prmAnno', 'int')]),
  op('WSLegislativo', 'retornarMocionesXAnno', '/mociones', 'collection', [q('anno', 'prmAnno', 'int')]),
  op('WSLegislativo', 'retornarProyectoLey', '/proyectos/:boletin', 'single', [p('boletin', 'prmNumeroBoletin', 'string')], 600),
  op('WSLegislativo', 'retornarProyectosLeyxNumeroLey', '/proyectos/por-ley/:numero', 'collection', [p('numero', 'prmNumeroLey', 'string')], 3600),
  op('WSLegislativo', 'retornarTramitesConstitucionales', '/tramites/constitucionales', 'collection', [], 3600),
  op('WSLegislativo', 'retornarTramitesReglamentarios', '/tramites/reglamentarios', 'collection', [], 3600),
  op('WSLegislativo', 'retornarVotacionesXAnno', '/votaciones', 'collection', [q('anno', 'prmAnno', 'int')], 300, { legible: true }),
  op('WSLegislativo', 'retornarVotacionesXProyectoLey', '/votaciones', 'collection', [q('boletin', 'prmNumeroBoletin', 'string')], 300, { legible: true }),
  op('WSLegislativo', 'retornarVotacionDetalle', '/votaciones/:id', 'single', [p('id', 'prmVotacionId', 'int')], 600, { legible: true, votosPerfil: true }),

  op('WSDiputado', 'retornarDiputados', '/diputados', 'collection', [], 600),
  op('WSDiputado', 'retornarDiputadosPeriodoActual', '/diputados/periodo-actual', 'collection', [], 600, { flatten: 'diputado', enrich: 'distrito' }),
  op('WSDiputado', 'retornarDiputadosXPeriodo', '/diputados/periodo/:id', 'collection', [p('id', 'prmPeriodoID', 'int')], 600, { flatten: 'diputado', enrich: 'distrito' }),
  op('WSDiputado', 'retornarDiputado', '/diputados/:id', 'single', [p('id', 'prmDiputadoId', 'int')], 600),

  op('WSComision', 'retornarComisionesVigentes', '/comisiones', 'collection', [], 600),
  op('WSComision', 'retornarComisionesXPeriodo', '/comisiones/periodo/:id', 'collection', [p('id', 'prmPeriodoId', 'int')], 600),
  op('WSComision', 'retornarComision', '/comisiones/:id', 'single', [p('id', 'prmComisionId', 'int')], 600),
  op('WSComision', 'retornarSesionesXComisionYAnno', '/comisiones/:id/sesiones', 'collection', [p('id', 'prmComisionId', 'int'), q('anno', 'prmAnno', 'int')]),

  op('WSSala', 'retornarSesionesXAnno', '/sesiones', 'collection', [q('anno', 'prmAnno', 'int')], 300),
  op('WSSala', 'retornarSesionesXLegislatura', '/sesiones', 'collection', [q('legislatura', 'prmLegislaturaId', 'int')]),
  op('WSSala', 'retornarSesionAsistencia', '/sesiones/:id', 'single', [p('id', 'prmSesionId', 'int')], 600),

  op('WSComun', 'retornarRegiones', '/catalogos/regiones', 'collection', [], 3600),
  op('WSComun', 'retornarProvincias', '/catalogos/provincias', 'collection', [], 3600),
  op('WSComun', 'retornarComunas', '/catalogos/comunas', 'collection', [], 3600),
  op('WSComun', 'retornarDistritos', '/catalogos/distritos', 'collection', [], 3600),
  op('WSComun', 'retornarMinisterios', '/catalogos/ministerios', 'collection', [], 3600),
  op('WSComun', 'retornarPartidosPoliticos', '/catalogos/partidos', 'collection', [], 3600),
  ...Object.entries(TIPO_METODOS).map(([slug, method]) =>
    op('WSComun', method, `/catalogos/tipos/${slug}`, 'collection', [], 3600)
  ),

  op('WSProyectosAcuerdo', 'retornarProyectosAcuerdoXAnno', '/proyectos/acuerdos', 'collection', [q('anno', 'prmAnno', 'int')]),
  op('WSProyectosAcuerdo', 'retornarProyectoAcuerdo', '/proyectos/acuerdos/:id', 'single', [p('id', 'prmProyectoAcuerdoId', 'int')], 600),
  op('WSProyectosResolucion', 'retornarProyectosResolucionXAnno', '/proyectos/resoluciones', 'collection', [q('anno', 'prmAnno', 'int')]),
  op('WSProyectosResolucion', 'retornarProyectoResolucion', '/proyectos/resoluciones/:id', 'single', [p('id', 'prmProyectoResolucionId', 'int')], 600),
];
