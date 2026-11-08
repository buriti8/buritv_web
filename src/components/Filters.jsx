import Icon from './Icon';

/** Buscador + pestañas de categoría (con Favoritos si hay). */
export default function Filters({ filter, totalCount, searchRef }) {
    const { query, setQuery, category, setCategory, categories } = filter;
    return (
        <div className="filters">
            <label className="search">
                <Icon name="search" size={18} />
                <input
                    ref={searchRef}
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={`Buscar en ${totalCount} canales`}
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="Buscar canal"
                />
                {query && (
                    <button
                        type="button"
                        className="search-clear"
                        onClick={() => setQuery('')}
                        aria-label="Borrar búsqueda"
                    >
                        <Icon name="close" size={14} />
                    </button>
                )}
            </label>
            {categories.length > 0 && (
                <div className="tabs" role="tablist" aria-label="Categorías">
                    {categories.map((c) => (
                        <button
                            key={c.id}
                            type="button"
                            role="tab"
                            aria-selected={c.id === category}
                            className={`tab${c.id === category ? ' on' : ''}`}
                            onClick={() => setCategory(c.id)}
                        >
                            {c.fav && <Icon name="star" size={14} className="tab-star" />}
                            {c.live && <span className="dot live" />}
                            <span className="tab-label">{c.label}</span>
                            <span className="tab-count">{c.count}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

export function EmptyResults({ query, onClear }) {
    return (
        <div className="empty">
            <Icon name="tv" size={28} />
            <p>{query ? `Sin resultados para "${query}"` : 'No hay canales en esta categoría'}</p>
            <button type="button" className="btn-tonal" onClick={onClear}>
                Ver todos los canales
            </button>
        </div>
    );
}
