-- Row-level security policies call current_tenant(), current_org() and is_operator(). Written bare, Postgres
-- evaluates them for every row it examines; wrapped in a scalar subquery it evaluates each once per query.
-- Same policies, same meaning: this rewrites every policy in the schema to the wrapped form.
do $$
declare p record; q text; c text;
begin
  for p in select tablename, policyname, qual, with_check from pg_policies where schemaname = 'public' loop
    q := p.qual; c := p.with_check;
    q := replace(replace(replace(q, 'current_tenant()', '(select current_tenant())'), 'current_org()', '(select current_org())'), 'is_operator()', '(select is_operator())');
    if c is not null then
      c := replace(replace(replace(c, 'current_tenant()', '(select current_tenant())'), 'current_org()', '(select current_org())'), 'is_operator()', '(select is_operator())');
    end if;
    if q is not null then execute format('alter policy %I on %I using (%s)', p.policyname, p.tablename, q); end if;
    if c is not null then execute format('alter policy %I on %I with check (%s)', p.policyname, p.tablename, c); end if;
  end loop;
end $$;
